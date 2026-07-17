import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import * as db from './db.js';
import { chat } from './llm.js';
import {
  afterChapterWritten,
  buildWritingContext,
  generateOutline,
  getOutlineBatchCount,
  rebuildGlobalSummaryBefore,
  regenerateContinuationOutline,
  writeChapter,
} from './context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_CHAPTERS = 1000;

db.recoverInterruptedJobs();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function settings() {
  return db.getAllSettings();
}

function parseProject(project) {
  if (!project) return null;
  const parsed = { ...project };
  for (const key of ['outline', 'characters', 'timeline', 'plot', 'world']) {
    try {
      parsed[key] = JSON.parse(project[`${key}_json`] || (key.endsWith('s') ? '[]' : '{}'));
    } catch {
      parsed[key] = key === 'characters' || key === 'timeline' ? [] : {};
    }
    delete parsed[`${key}_json`];
  }
  parsed.chapters = db.listChapters(project.id);
  parsed.generation_job = publicGenerationJob(db.getLatestGenerationJob(project.id));
  return parsed;
}

function publicGenerationJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    total_batches: job.total_batches,
    completed_batches: job.completed_batches,
    current_batch: job.current_batch,
    error: job.error,
    updated_at: job.updated_at,
  };
}

function requireProject(req, res) {
  const project = db.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return null;
  }
  return project;
}

function validateProjectInput(body) {
  const title = String(body.title || '').trim();
  const genre = String(body.genre || '').trim();
  const theme = String(body.theme || '').trim();
  const chapterCount = Number(body.chapter_count);
  const words = Number(body.words_per_chapter || 2000);
  if (!title || !genre || !theme) throw new Error('书名、类型和主题不能为空');
  if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > MAX_CHAPTERS) {
    throw new Error(`章数应为 1 到 ${MAX_CHAPTERS} 的整数`);
  }
  if (!Number.isInteger(words) || words < 500 || words > 10000) {
    throw new Error('每章字数应为 500 到 10000');
  }
  return { title, genre, theme, chapterCount, words };
}

const REFERENCE_MODES = new Set(['logic', 'style', 'expansion', 'comprehensive']);

function validateReference(referenceProjectId, referenceMode, currentProjectId = '') {
  const id = String(referenceProjectId || '').trim();
  if (!id) return { id: '', mode: '' };
  if (id === currentProjectId) throw new Error('不能参考当前作品自身');
  if (!db.getProject(id)) throw new Error('参考作品不存在');
  const mode = REFERENCE_MODES.has(referenceMode) ? referenceMode : 'logic';
  return { id, mode };
}

function parseJSON(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function buildSequelPrompt(source, customPrompt) {
  const characters = parseJSON(source.characters_json, []);
  const world = parseJSON(source.world_json, {});
  const plot = parseJSON(source.plot_json, {});
  const lastChapter = db.listChapters(source.id)
    .filter((chapter) => chapter.status === 'done')
    .at(-1);

  const characterBrief = characters.slice(0, 10).map((character) =>
    [character.name, character.role, character.personality, character.goal, character.arc]
      .filter(Boolean)
      .join(' | ')
  ).join('\n');

  const sourceBrief = [
    `【原作《${source.title}》的续作约束】`,
    `原作全局摘要：${(source.global_summary || plot.premise || '暂无').slice(0, 2800)}`,
    lastChapter?.summary ? `原作最后一章摘要：${lastChapter.summary.slice(0, 1000)}` : '',
    lastChapter?.content ? `原作结尾片段：${lastChapter.content.slice(-1200)}` : '',
    characterBrief ? `原作主要人物（姓名和既有关系必须保持）：\n${characterBrief.slice(0, 2600)}` : '',
    world.setting ? `原作世界背景：${String(world.setting).slice(0, 900)}` : '',
    world.rules ? `原作世界规则：${String(world.rules).slice(0, 900)}` : '',
    plot.conflict ? `原作主要冲突：${String(plot.conflict).slice(0, 700)}` : '',
    '新故事必须承接原作结局与人物状态，不得复述原作主线；需要发展新的核心冲突和人物弧光。',
  ].filter(Boolean).join('\n\n');

  const suffix = customPrompt ? `\n\n【本次续作补充设定】\n${customPrompt}` : '';
  const available = Math.max(1000, 10000 - suffix.length);
  return `${sourceBrief.slice(0, available)}${suffix}`.slice(0, 10000);
}

function saveOutline(project, outline) {
  const normalized = {
    title_suggestion: outline.title_suggestion || project.title,
    world: outline.world || {},
    characters: Array.isArray(outline.characters) ? outline.characters : [],
    timeline: Array.isArray(outline.timeline) ? outline.timeline : [],
    plot: outline.plot || {},
    chapters: Array.isArray(outline.chapters) ? outline.chapters : [],
  };
  if (normalized.chapters.length !== project.chapter_count) {
    throw new Error(`章节大纲必须正好包含 ${project.chapter_count} 章`);
  }
  normalized.chapters = normalized.chapters.map((chapter, index) => ({
    ...chapter,
    num: index + 1,
    title: String(chapter.title || `第${index + 1}章`).trim(),
    summary: String(chapter.summary || '').trim(),
  }));

  db.updateProject(project.id, {
    outline_json: JSON.stringify(normalized),
    characters_json: JSON.stringify(normalized.characters),
    timeline_json: JSON.stringify(normalized.timeline),
    plot_json: JSON.stringify(normalized.plot),
    world_json: JSON.stringify(normalized.world),
    status: 'outline_review',
  });

  for (const chapter of normalized.chapters) {
    const existing = db.getChapter(project.id, chapter.num);
    db.upsertChapter({
      id: existing?.id || uuid(),
      project_id: project.id,
      chapter_num: chapter.num,
      title: chapter.title,
      outline: chapter.summary,
      content: existing?.content || '',
      summary: existing?.summary || '',
      status: existing?.status || 'pending',
    });
  }
  return normalized;
}

const activeOutlineJobs = new Set();

async function runOutlineJob(jobId) {
  if (activeOutlineJobs.has(jobId)) return;
  activeOutlineJobs.add(jobId);
  try {
    const job = db.getGenerationJob(jobId);
    const project = job && db.getProject(job.project_id);
    if (!job || !project || job.status !== 'running') return;
    let checkpoint = {};
    try { checkpoint = JSON.parse(job.checkpoint_json || '{}'); } catch {}

    const outline = await generateOutline(project, settings(), {
      checkpoint,
      onPlan: (plan) => {
        checkpoint = { plan, chapters: [] };
        db.updateGenerationJob(jobId, {
          completed_batches: 1,
          current_batch: 2,
          checkpoint_json: JSON.stringify(checkpoint),
        });
      },
      onBatch: ({ plan, chapters, completedBatches, totalBatches }) => {
        checkpoint = { plan, chapters };
        db.updateGenerationJob(jobId, {
          total_batches: totalBatches,
          completed_batches: completedBatches,
          current_batch: Math.min(totalBatches, completedBatches + 1),
          checkpoint_json: JSON.stringify(checkpoint),
        });
      },
    });
    saveOutline(project, outline);
    db.updateGenerationJob(jobId, {
      status: 'done',
      completed_batches: job.total_batches,
      current_batch: job.total_batches,
      error: '',
      checkpoint_json: JSON.stringify({ plan: checkpoint.plan, chapters: outline.chapters }),
    });
  } catch (error) {
    const job = db.getGenerationJob(jobId);
    if (job) {
      db.updateGenerationJob(jobId, { status: 'failed', error: error.message });
      db.updateProject(job.project_id, { status: 'planning_failed' });
    }
    console.error(error);
  } finally {
    activeOutlineJobs.delete(jobId);
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/settings', (req, res) => {
  const current = settings();
  res.json({
    base_url: current.base_url || 'https://api.openai.com/v1',
    model: current.model || 'gpt-4o-mini',
    temperature: current.temperature || '0.85',
    max_tokens: current.max_tokens || '4096',
    has_api_key: Boolean(current.api_key),
  });
});

app.put('/api/settings', (req, res) => {
  const allowed = ['base_url', 'model', 'temperature', 'max_tokens'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) db.setSetting(key, String(req.body[key]).trim());
  }
  if (req.body.api_key !== undefined && String(req.body.api_key).trim()) {
    db.setSetting('api_key', String(req.body.api_key).trim());
  }
  res.json({ ok: true });
});

app.post('/api/settings/test', asyncRoute(async (req, res) => {
  const reply = await chat(
    [{ role: 'user', content: '只回复“连接成功”四个字。' }],
    settings(),
    { temperature: 0, maxTokens: 20 }
  );
  res.json({ ok: true, reply: reply.trim() });
}));

app.get('/api/projects', (req, res) => res.json(db.listProjects()));

app.post('/api/projects', (req, res) => {
  try {
    const { title, genre, theme, chapterCount, words } = validateProjectInput(req.body);
    const reference = validateReference(req.body.reference_project_id, req.body.reference_mode);
    const extraPrompt = String(req.body.extra_prompt || '').trim();
    if (extraPrompt.length > 10000) throw new Error('自定义设定不能超过 10000 字');
    const project = db.createProject({
      id: uuid(),
      title,
      genre,
      theme,
      chapter_count: chapterCount,
      words_per_chapter: words,
      style: String(req.body.style || '').trim(),
      extra_prompt: extraPrompt,
      status: 'draft',
    });
    if (reference.id) {
      db.updateProject(project.id, {
        reference_project_id: reference.id,
        reference_mode: reference.mode,
      });
    }
    res.status(201).json(parseProject(db.getProject(project.id)));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/projects/:id/derive', (req, res) => {
  const source = requireProject(req, res);
  if (!source) return;
  try {
    const mode = req.body.mode === 'sequel' ? 'sequel' : 'template';
    const { title, genre, theme, chapterCount, words } = validateProjectInput(req.body);
    const customPrompt = String(req.body.extra_prompt || '').trim();
    if (customPrompt.length > 10000) throw new Error('自定义设定不能超过 10000 字');
    if (mode === 'sequel' && customPrompt.length > 5000) {
      throw new Error('写后续时补充设定不能超过 5000 字，请精简后重试');
    }
    const extraPrompt = mode === 'sequel'
      ? buildSequelPrompt(source, customPrompt)
      : customPrompt;

    const project = db.createProject({
      id: uuid(),
      title,
      genre,
      theme,
      chapter_count: chapterCount,
      words_per_chapter: words,
      style: String(req.body.style || '').trim(),
      extra_prompt: extraPrompt,
      status: 'draft',
    });
    if (source.reference_project_id) {
      db.updateProject(project.id, {
        reference_project_id: source.reference_project_id,
        reference_mode: source.reference_mode,
      });
    }
    res.status(201).json(parseProject(db.getProject(project.id)));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/projects/:id', (req, res) => {
  const project = requireProject(req, res);
  if (project) res.json(parseProject(project));
});

app.patch('/api/projects/:id', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (project.status !== 'draft') {
    return res.status(409).json({ error: '只能在生成大纲前修改自定义设定' });
  }
  const extraPrompt = String(req.body.extra_prompt || '').trim();
  if (extraPrompt.length > 10000) {
    return res.status(400).json({ error: '自定义设定不能超过 10000 字' });
  }
  try {
    const reference = validateReference(
      req.body.reference_project_id,
      req.body.reference_mode,
      project.id
    );
    res.json(parseProject(db.updateProject(project.id, {
      extra_prompt: extraPrompt,
      reference_project_id: reference.id,
      reference_mode: reference.mode,
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  db.deleteProject(project.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/outline/generate', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (project.status === 'writing' || project.status === 'completed') {
    return res.status(409).json({ error: '已开始写作，不能重新生成全书大纲' });
  }
  const latest = db.getLatestGenerationJob(project.id);
  if (latest?.status === 'running') {
    return res.status(202).json(publicGenerationJob(latest));
  }
  const totalBatches = getOutlineBatchCount(project.chapter_count);
  const job = db.createGenerationJob({
    id: uuid(),
    project_id: project.id,
    job_type: 'outline',
    status: 'running',
    total_batches: totalBatches,
    completed_batches: 0,
    current_batch: 1,
    error: '',
    checkpoint_json: '{}',
  });
  db.updateProject(project.id, { status: 'planning' });
  setImmediate(() => void runOutlineJob(job.id));
  res.status(202).json(publicGenerationJob(job));
});

app.post('/api/projects/:id/outline/retry', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const job = db.getLatestGenerationJob(project.id);
  if (!job || job.status !== 'failed') {
    return res.status(409).json({ error: '没有可恢复的失败批次' });
  }
  const resumed = db.updateGenerationJob(job.id, {
    status: 'running',
    current_batch: Math.min(job.total_batches, job.completed_batches + 1),
    error: '',
  });
  db.updateProject(project.id, { status: 'planning' });
  setImmediate(() => void runOutlineJob(job.id));
  res.status(202).json(publicGenerationJob(resumed));
});

app.put('/api/projects/:id/outline', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (project.status === 'writing' || project.status === 'completed') {
    return res.status(409).json({ error: '写作开始后不能整体替换大纲' });
  }
  try {
    saveOutline(project, req.body);
    res.json(parseProject(db.getProject(project.id)));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/projects/:id/outline/confirm', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (!project.outline_json) return res.status(400).json({ error: '请先生成大纲' });
  db.updateProject(project.id, { status: 'ready' });
  res.json(parseProject(db.getProject(project.id)));
});

app.post('/api/projects/:id/outline/regenerate', asyncRoute(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (!project.outline_json) return res.status(400).json({ error: '请先生成并确认原始大纲' });
  const startChapter = Number(req.body.start_chapter);
  const newChapterCount = Number(req.body.chapter_count);
  const instruction = String(req.body.instruction || '').trim();
  if (!Number.isInteger(startChapter) || startChapter < 1 || startChapter > project.chapter_count) {
    return res.status(400).json({ error: '起始章节必须是现有章节' });
  }
  if (!Number.isInteger(newChapterCount) || newChapterCount < startChapter || newChapterCount > MAX_CHAPTERS) {
    return res.status(400).json({ error: `新总章数应在 ${startChapter} 到 ${MAX_CHAPTERS} 之间` });
  }
  if (!instruction) return res.status(400).json({ error: '请填写后续调整要求' });
  if (instruction.length > 5000) return res.status(400).json({ error: '调整要求不能超过 5000 字' });
  const chapters = db.listChapters(project.id);
  if (chapters.some((chapter) => ['writing', 'summarizing'].includes(chapter.status))) {
    return res.status(409).json({ error: '当前有章节正在生成，请完成后再重规划' });
  }

  const previousStatus = project.status;
  db.updateProject(project.id, { status: 'replanning' });
  try {
    const outline = await regenerateContinuationOutline(
      project,
      startChapter,
      newChapterCount,
      instruction,
      settings()
    );
    const removesCompleted = chapters.some(
      (chapter) => chapter.chapter_num >= startChapter && chapter.status === 'done'
    );
    const globalSummary = removesCompleted
      ? await rebuildGlobalSummaryBefore(project.id, startChapter, settings())
      : project.global_summary;
    const suffix = `【从第${startChapter}章起的后续调整】\n${instruction}`;
    const previousPrompt = String(project.extra_prompt || '').slice(0, Math.max(0, 10000 - suffix.length - 2));
    const status = chapters.some(
      (chapter) => chapter.chapter_num < startChapter && chapter.status === 'done'
    ) ? 'writing' : 'ready';
    const newChapters = outline.chapters
      .filter((chapter) => chapter.num >= startChapter)
      .map((chapter) => ({
        id: uuid(),
        project_id: project.id,
        chapter_num: chapter.num,
        title: chapter.title,
        outline: chapter.summary,
        content: '',
        summary: '',
        status: 'pending',
      }));
    db.replaceContinuation(project.id, startChapter, {
      chapter_count: newChapterCount,
      outline_json: JSON.stringify(outline),
      characters_json: JSON.stringify(outline.characters || []),
      timeline_json: JSON.stringify(outline.timeline || []),
      plot_json: JSON.stringify(outline.plot || {}),
      extra_prompt: [previousPrompt, suffix].filter(Boolean).join('\n\n'),
      global_summary: globalSummary,
      status,
    }, newChapters);
    res.json(parseProject(db.getProject(project.id)));
  } catch (error) {
    db.updateProject(project.id, { status: previousStatus });
    throw error;
  }
}));

app.put('/api/projects/:id/chapters/:num', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const num = Number(req.params.num);
  const chapter = db.getChapter(project.id, num);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (chapter.status === 'done') {
    return res.status(409).json({ error: '完成章节已进入上下文记忆，不能直接修改' });
  }
  const update = {};
  for (const key of ['title', 'outline', 'content']) {
    if (req.body[key] !== undefined) update[key] = String(req.body[key]);
  }
  res.json(db.updateChapter(project.id, num, update));
});

app.get('/api/projects/:id/chapters/:num/context', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const num = Number(req.params.num);
  if (!db.getChapter(project.id, num)) return res.status(404).json({ error: '章节不存在' });
  res.type('text/plain').send(buildWritingContext(project, num));
});

app.post('/api/projects/:id/chapters/:num/generate', asyncRoute(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const num = Number(req.params.num);
  const chapter = db.getChapter(project.id, num);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (!['ready', 'writing'].includes(project.status)) {
    return res.status(409).json({ error: '请先确认大纲' });
  }
  if (chapter.status === 'done') {
    return res.status(409).json({ error: '本章已完成，为避免污染滚动摘要不能直接重写' });
  }
  if (chapter.status === 'writing' || chapter.status === 'summarizing') {
    return res.status(409).json({ error: '本章已有后台任务正在执行' });
  }
  const unfinishedPrevious = db.listChapters(project.id).find(
    (item) => item.chapter_num < num && item.status !== 'done'
  );
  if (unfinishedPrevious) {
    return res.status(409).json({ error: `请先完成第 ${unfinishedPrevious.chapter_num} 章` });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  db.updateProject(project.id, { status: 'writing' });
  db.updateChapter(project.id, num, { status: 'writing', content: '' });
  send('phase', { phase: 'writing' });
  let content = '';
  let writingFinished = false;
  let persistedLength = 0;
  try {
    const stream = await writeChapter(project, num, settings(), { stream: true });
    for await (const delta of stream) {
      content += delta;
      send('delta', { text: delta });
      if (content.length - persistedLength >= 500) {
        db.updateChapter(project.id, num, { content });
        persistedLength = content.length;
      }
    }
    writingFinished = true;
    db.updateChapter(project.id, num, { content, status: 'summarizing' });
    send('phase', { phase: 'summarizing' });
    const memory = await afterChapterWritten(project.id, num, settings());
    const doneCount = db.listChapters(project.id).filter((item) => item.status === 'done').length;
    if (doneCount === project.chapter_count) db.updateProject(project.id, { status: 'completed' });
    send('done', { chapter: db.getChapter(project.id, num), memory });
  } catch (error) {
    db.updateChapter(project.id, num, {
      content,
      status: writingFinished ? 'generated' : 'pending',
    });
    send('error', { error: error.message });
  } finally {
    res.end();
  }
}));

app.post('/api/projects/:id/chapters/:num/finalize', asyncRoute(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const num = Number(req.params.num);
  const chapter = db.getChapter(project.id, num);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (chapter.status !== 'generated' || !chapter.content.trim()) {
    return res.status(409).json({ error: '仅可整理已生成但摘要失败的章节' });
  }
  db.updateChapter(project.id, num, { status: 'summarizing' });
  try {
    const memory = await afterChapterWritten(project.id, num, settings());
    const doneCount = db.listChapters(project.id).filter((item) => item.status === 'done').length;
    db.updateProject(project.id, {
      status: doneCount === project.chapter_count ? 'completed' : 'writing',
    });
    res.json({ chapter: db.getChapter(project.id, num), memory });
  } catch (error) {
    db.updateChapter(project.id, num, { status: 'generated' });
    throw error;
  }
}));

app.get('/api/projects/:id/export', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const chapters = db.listChapters(project.id).filter((chapter) => chapter.content);
  const body = chapters
    .map((chapter) => `第${chapter.chapter_num}章 ${chapter.title}\n\n${chapter.content}`)
    .join('\n\n\n');
  const filename = encodeURIComponent(`${project.title}.txt`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(`《${project.title}》\n\n${body}`);
});

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: error.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`小说工坊已启动：http://localhost:${PORT}`);
});
