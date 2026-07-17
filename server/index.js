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
  writeChapter,
} from './context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

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
  return parsed;
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
  if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 200) {
    throw new Error('章数应为 1 到 200 的整数');
  }
  if (!Number.isInteger(words) || words < 500 || words > 10000) {
    throw new Error('每章字数应为 500 到 10000');
  }
  return { title, genre, theme, chapterCount, words };
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
    res.status(201).json(parseProject(project));
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
  res.json(parseProject(db.updateProject(project.id, { extra_prompt: extraPrompt })));
});

app.delete('/api/projects/:id', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  db.deleteProject(project.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/outline/generate', asyncRoute(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (project.status === 'writing' || project.status === 'completed') {
    return res.status(409).json({ error: '已开始写作，不能重新生成全书大纲' });
  }
  db.updateProject(project.id, { status: 'planning' });
  try {
    const outline = await generateOutline(project, settings());
    saveOutline(project, outline);
    res.json(parseProject(db.getProject(project.id)));
  } catch (error) {
    db.updateProject(project.id, { status: 'draft' });
    throw error;
  }
}));

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
