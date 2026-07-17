/**
 * 上下文管理：分层摘要 + 滚动窗口，避免 token 爆炸，保证章节连贯
 *
 * 策略：
 * 1. 全局摘要 global_summary（全书压缩记忆）
 * 2. 近期完整章（最近 1 章正文或摘要）
 * 3. 本章大纲 + 人物/时间线/世界设定精简
 * 4. 关键事件记忆（角色状态、伏笔、地点变化）
 * 5. 每写完一章自动生成章节摘要，并滚动更新全局摘要
 */

import { v4 as uuid } from 'uuid';
import { chat, chatJSON, extractJSON } from './llm.js';
import * as db from './db.js';

const RECENT_FULL_CHAPTERS = 1;
const RECENT_SUMMARY_CHAPTERS = 5;
const OUTLINE_BATCH_SIZE = 20;
const BATCHED_OUTLINE_THRESHOLD = 50;

export function getOutlineBatchCount(chapterCount) {
  return chapterCount > BATCHED_OUTLINE_THRESHOLD
    ? 1 + Math.ceil(chapterCount / OUTLINE_BATCH_SIZE)
    : 1;
}

function safeJSON(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

export function buildReferenceContext(project) {
  if (!project.reference_project_id || project.reference_project_id === project.id) return '';
  const reference = db.getProject(project.reference_project_id);
  if (!reference) return '';

  const mode = project.reference_mode || 'logic';
  const plot = safeJSON(reference.plot_json, {});
  const world = safeJSON(reference.world_json, {});
  const characters = safeJSON(reference.characters_json, []);
  const outline = safeJSON(reference.outline_json, {});
  const chapterLogic = (outline.chapters || []).slice(0, 20)
    .map((chapter) => `第${chapter.num}章 ${chapter.title}: ${chapter.summary}`)
    .join('\n')
    .slice(0, 4500);
  const sampleChapter = db.listChapters(reference.id)
    .filter((chapter) => chapter.content)
    .at(-1);

  const sections = [`【参考作品：《${reference.title}》】`];
  if (mode === 'logic' || mode === 'expansion' || mode === 'comprehensive') {
    sections.push(`核心逻辑：${plot.premise || reference.theme}`);
    if (plot.conflict) sections.push(`冲突结构：${plot.conflict}`);
    if (plot.structure) sections.push(`叙事结构：${plot.structure}`);
    if (chapterLogic) sections.push(`章节推进参考：\n${chapterLogic}`);
  }
  if (mode === 'expansion' || mode === 'comprehensive') {
    if (world.setting) sections.push(`世界展开方式：${String(world.setting).slice(0, 1200)}`);
    if (characters.length) {
      sections.push(`角色功能参考：${characters.slice(0, 8).map((item) => `${item.role || '角色'}-${item.arc || item.goal || ''}`).join('；')}`);
    }
  }
  if (mode === 'style' || mode === 'comprehensive') {
    sections.push(`文风标注：${reference.style || '从样本中提炼句式、节奏、视角和对话密度'}`);
    if (sampleChapter?.content) {
      sections.push(`文风样本（仅提炼特征，不得复用句子）：\n${sampleChapter.content.slice(0, 1800)}`);
    }
  }
  sections.push('只借鉴抽象逻辑、节奏或文风特征；不得复制参考作品的人名、专有设定、具体事件、原句或章节标题。');
  return sections.join('\n\n').slice(0, 9000);
}

async function generateChapterBatches({
  project,
  plan,
  startChapter,
  endChapter,
  priorChapters = [],
  instruction = '',
  referenceContext = '',
  existingChapters = [],
  onBatch,
  settings,
}) {
  const generated = [...existingChapters];
  const planBrief = JSON.stringify({
    world: plan.world || {},
    characters: plan.characters || [],
    plot: plan.plot || plan.plot_update || {},
    timeline: plan.timeline || [],
    arcs: plan.arcs || [],
  }).slice(0, 22000);

  for (
    let batchStart = startChapter + generated.length;
    batchStart <= endChapter;
    batchStart += OUTLINE_BATCH_SIZE
  ) {
    const batchEnd = Math.min(endChapter, batchStart + OUTLINE_BATCH_SIZE - 1);
    const batchCount = batchEnd - batchStart + 1;
    const recent = [...priorChapters, ...generated].slice(-4)
      .map((chapter) => `第${chapter.num}章《${chapter.title}》：${chapter.summary}`)
      .join('\n');
    const prompt = `为《${project.title}》生成第${batchStart}章到第${batchEnd}章的逐章大纲。
输出严格 JSON：{"chapters":[{"num":${batchStart},"title":"章名","summary":"80-150字剧情","key_events":["事件"],"pov":"视角人物","ending_hook":"章末钩子"}]}

要求：
- chapters 必须正好 ${batchCount} 项，num 从 ${batchStart} 连续到 ${batchEnd}
- 全书总章数 ${endChapter}，当前批次必须符合全书阶段与收束节奏
- 总纲：${planBrief}
- 用户调整：${instruction || project.extra_prompt || '无'}
- 上一批结尾：${recent || '这是第一批，从开篇建立冲突'}
${referenceContext ? `- 参考约束：${referenceContext}` : ''}
- 相邻章节因果连续，不得重复事件，不得提前透支后续阶段
- 只输出 JSON`;
    const data = await chatJSON(
      [
        { role: 'system', content: '你是长篇小说分章编辑，严格按指定编号输出合法 JSON。' },
        { role: 'user', content: prompt },
      ],
      settings,
      { temperature: 0.75, maxTokens: 14000 }
    );
    let batch = Array.isArray(data.chapters) ? data.chapters : [];
    while (batch.length < batchCount) {
      const num = batchStart + batch.length;
      batch.push({ num, title: `第${num}章`, summary: '待细化', key_events: [], ending_hook: '' });
    }
    batch = batch.slice(0, batchCount).map((chapter, index) => ({
      ...chapter,
      num: batchStart + index,
      title: chapter.title || `第${batchStart + index}章`,
      summary: chapter.summary || '',
    }));
    generated.push(...batch);
    if (onBatch) await onBatch([...generated], { batchStart, batchEnd });
  }
  return generated;
}

export function buildWritingContext(project, chapterNum) {
  const chapters = db.listChapters(project.id);
  const done = chapters.filter((c) => c.status === 'done' && c.chapter_num < chapterNum);
  const current = chapters.find((c) => c.chapter_num === chapterNum);

  let characters = [];
  let timeline = [];
  let plot = {};
  let world = {};
  let outline = {};
  try { characters = JSON.parse(project.characters_json || '[]'); } catch {}
  try { timeline = JSON.parse(project.timeline_json || '[]'); } catch {}
  try { plot = JSON.parse(project.plot_json || '{}'); } catch {}
  try { world = JSON.parse(project.world_json || '{}'); } catch {}
  try { outline = JSON.parse(project.outline_json || '{}'); } catch {}

  const chapterOutlines = outline.chapters || [];
  const thisOutline = chapterOutlines.find((c) => c.num === chapterNum) || {
    title: current?.title,
    summary: current?.outline,
  };

  // 近期完整/摘要
  const recentFull = done.slice(-RECENT_FULL_CHAPTERS);
  const olderForSummary = done.slice(0, Math.max(0, done.length - RECENT_FULL_CHAPTERS));
  const recentSummaries = olderForSummary.slice(-RECENT_SUMMARY_CHAPTERS);

  const characterBrief = characters.map((c) => {
    const bits = [c.name, c.role, c.personality, c.goal].filter(Boolean);
    if (c.arc) bits.push(`弧光:${c.arc}`);
    return `- ${bits.join(' | ')}`;
  }).join('\n');

  const worldBrief = [
    world.setting && `背景：${world.setting}`,
    world.rules && `规则：${world.rules}`,
    world.tone && `基调：${world.tone}`,
    Array.isArray(world.locations) && world.locations.length
      ? `地点：${world.locations.map((l) => (typeof l === 'string' ? l : l.name)).join('、')}`
      : '',
  ].filter(Boolean).join('\n');

  const plotBrief = [
    plot.premise && `核心：${plot.premise}`,
    plot.conflict && `冲突：${plot.conflict}`,
    plot.ending_direction && `结局方向：${plot.ending_direction}`,
    Array.isArray(plot.hooks) && plot.hooks.length ? `伏笔：${plot.hooks.join('；')}` : '',
  ].filter(Boolean).join('\n');

  const timelineBrief = (timeline || [])
    .filter((t) => !t.chapter_range || inRange(t.chapter_range, chapterNum))
    .slice(0, 12)
    .map((t) => `- ${t.time || ''}: ${t.event || t}`)
    .join('\n');

  const memoryLines = db.getMemories(project.id, chapterNum - 1)
    .slice(-30)
    .map((m) => `[${m.memory_type}] 第${m.chapter_num}章: ${m.content}`)
    .join('\n');

  const recentSummaryText = recentSummaries
    .map((c) => `第${c.chapter_num}章《${c.title}》摘要：${c.summary || '（无）'}`)
    .join('\n');

  const recentFullText = recentFull
    .map((c) => {
      // 若正文过长，只取末尾
      const body = c.content || '';
      const clipped = body.length > 3500 ? '…' + body.slice(-3500) : body;
      return `【第${c.chapter_num}章《${c.title}》正文（近期，供衔接）】\n${clipped}`;
    })
    .join('\n\n');

  const parts = [
    `# 小说：《${project.title}》`,
    `类型：${project.genre} | 主题：${project.theme}`,
    project.style ? `文风：${project.style}` : '',
    project.extra_prompt ? `用户自定义设定（必须遵守）：${project.extra_prompt}` : '',
    buildReferenceContext(project),
    '',
    '## 世界与设定',
    worldBrief || '（无）',
    '',
    '## 主要人物',
    characterBrief || '（无）',
    '',
    '## 大体剧情',
    plotBrief || '（无）',
    '',
    '## 相关时间线',
    timelineBrief || '（无）',
    '',
    '## 全书全局摘要（压缩记忆）',
    project.global_summary || '（尚无，从第1章开始）',
    '',
    '## 近期章节摘要',
    recentSummaryText || '（无）',
    '',
    '## 关键记忆（人物状态/伏笔/地点）',
    memoryLines || '（无）',
    '',
    recentFullText,
    '',
    `## 当前要写：第 ${chapterNum} 章`,
    `标题建议：${thisOutline.title || current?.title || ''}`,
    `本章大纲：${thisOutline.summary || thisOutline.outline || current?.outline || ''}`,
    thisOutline.key_events ? `关键事件：${Array.isArray(thisOutline.key_events) ? thisOutline.key_events.join('；') : thisOutline.key_events}` : '',
    thisOutline.ending_hook ? `章末钩子：${thisOutline.ending_hook}` : '',
  ];

  return parts.filter((p) => p !== undefined && p !== null).join('\n');
}

function inRange(range, n) {
  if (typeof range === 'string') {
    const m = range.match(/(\d+)\s*[-~到至]\s*(\d+)/);
    if (m) return n >= Number(m[1]) && n <= Number(m[2]);
    const single = Number(range);
    return !Number.isNaN(single) ? n === single : true;
  }
  if (Array.isArray(range) && range.length >= 2) return n >= range[0] && n <= range[1];
  return true;
}

export async function summarizeChapter(project, chapter, settings) {
  const content = chapter.content || '';
  if (!content.trim()) return { summary: '', memories: [] };

  let summarySource = content;
  if (content.length > 12000) {
    const chunks = [];
    for (let offset = 0; offset < content.length; offset += 6000) {
      chunks.push(content.slice(offset, offset + 6000));
    }
    const partials = [];
    for (let index = 0; index < chunks.length; index++) {
      const partial = await chat(
        [
          { role: 'system', content: '你是小说编辑，提取情节因果、人物状态变化、伏笔和关键物品。' },
          {
            role: 'user',
            content: `这是第${chapter.chapter_num}章的第${index + 1}/${chunks.length}段。请在300字内做信息密集的分段摘要，不要遗漏本段结尾：\n\n${chunks[index]}`,
          },
        ],
        settings,
        { temperature: 0.2, maxTokens: 800 }
      );
      partials.push(`第${index + 1}段：${partial.trim()}`);
    }
    summarySource = `以下是长章节的分段摘要，请按先后顺序归并：\n${partials.join('\n\n')}`;
  }

  const prompt = `你是小说编辑。请对以下章节做结构化摘要，输出严格 JSON（不要其它文字）：
{
  "summary": "200-400字情节摘要，保留因果与转折",
  "memories": [
    {"type": "character|plot|foreshadow|location|item", "content": "一条短记忆，可在后续章节引用"}
  ],
  "character_states": "主要人物本章末状态一句话"
}

章节：第${chapter.chapter_num}章《${chapter.title}》
正文或分段摘要：
${summarySource}`;

  const parsed = await chatJSON(
    [
      { role: 'system', content: '你只输出合法 JSON，不要 markdown 代码块外的说明。' },
      { role: 'user', content: prompt },
    ],
    settings,
    { temperature: 0.3, maxTokens: 1500 }
  );

  const summary = parsed.summary || '';
  const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
  if (parsed.character_states) {
    memories.push({ type: 'character', content: parsed.character_states });
  }
  return { summary, memories };
}

export async function updateGlobalSummary(project, chapter, chapterSummary, settings) {
  const prev = project.global_summary || '';
  const prompt = `维护长篇小说的「滚动全局摘要」，用于后续写作上下文。要求：
- 合并旧摘要与新章信息
- 控制在 600-900 字
- 保留未解决冲突、人物关系变化、重要伏笔、当前时间线位置
- 删除已无用细节

旧全局摘要：
${prev || '（空）'}

新完成：第${chapter.chapter_num}章《${chapter.title}》
本章摘要：
${chapterSummary}

只输出更新后的全局摘要正文，不要标题或 JSON。`;

  const text = await chat(
    [
      { role: 'system', content: '你是严谨的小说大纲编辑，输出简洁连贯的中文摘要。' },
      { role: 'user', content: prompt },
    ],
    settings,
    { temperature: 0.3, maxTokens: 1200 }
  );
  return text.trim();
}

export async function afterChapterWritten(projectId, chapterNum, settings) {
  const project = db.getProject(projectId);
  const chapter = db.getChapter(projectId, chapterNum);
  if (!project || !chapter) throw new Error('项目或章节不存在');

  const { summary, memories } = await summarizeChapter(project, chapter, settings);
  db.updateChapter(projectId, chapterNum, { summary, status: 'done' });

  db.deleteChapterMemories(projectId, chapterNum);
  for (const m of memories) {
    db.addMemory({
      id: uuid(),
      project_id: projectId,
      chapter_num: chapterNum,
      memory_type: m.type || 'plot',
      content: m.content || String(m),
    });
  }

  const globalSummary = await updateGlobalSummary(
    project,
    chapter,
    summary,
    settings
  );
  db.updateProject(projectId, { global_summary: globalSummary });

  return { summary, globalSummary, memoryCount: memories.length };
}

export async function generateOutline(project, settings, options = {}) {
  const referenceContext = buildReferenceContext(project);
  const batched = project.chapter_count > BATCHED_OUTLINE_THRESHOLD;
  const prompt = `请为一部网络小说规划完整大纲。输出严格 JSON（可含 markdown 代码块）：
{
  "title_suggestion": "书名建议",
  "world": {
    "setting": "世界观/时代背景",
    "rules": "特殊规则或力量体系（可无）",
    "tone": "叙事基调",
    "locations": [{"name":"地点","desc":"简述"}]
  },
  "characters": [
    {
      "name": "姓名",
      "role": "主角/反派/配角",
      "age": "年龄",
      "personality": "性格",
      "background": "背景",
      "goal": "目标",
      "arc": "人物弧光简述"
    }
  ],
  "timeline": [
    {"time": "时间点/阶段", "event": "事件", "chapter_range": "1-3"}
  ],
  "plot": {
    "premise": "一句话核心卖点",
    "conflict": "主要冲突",
    "structure": "三幕或卷结构简述",
    "ending_direction": "结局方向（可开放）",
    "hooks": ["伏笔1", "伏笔2"]
  },
  "arcs": [
    {"name":"篇章/卷名","chapter_range":"1-50","goal":"阶段目标","turning_points":["转折"]}
  ],
  "chapters": [
    {
      "num": 1,
      "title": "章名",
      "summary": "本章剧情要点 80-150字",
      "key_events": ["事件1"],
      "pov": "视角人物",
      "ending_hook": "章末钩子"
    }
  ]
}

要求：
- 类型：${project.genre}
- 主题：${project.theme}
- 总章数：${project.chapter_count}
${batched
    ? '- 这是超长篇：先用 arcs 覆盖全书分卷和阶段节奏，本次 chapters 必须返回空数组 []，逐章大纲将按批次生成'
    : `- chapters 数组必须正好 ${project.chapter_count} 项，num 从 1 到 ${project.chapter_count}`}
- 每章约 ${project.words_per_chapter || 2000} 字量级的情节密度
- 文风偏好：${project.style || '流畅网文，画面感强'}
- 用户自定义硬性设定：${project.extra_prompt || '无'}
- 必须优先遵守用户自定义设定，不得擅自修改其中预设的人物姓名、身份、关系、背景、世界规则和禁用内容
${referenceContext ? `- 参考要求：\n${referenceContext}` : ''}
- 人物 4-8 个主要角色即可
- 时间线覆盖全书节奏
- 章节之间因果连贯，有起承转合与爽点/张力节奏`;

  let data = options.checkpoint?.plan;
  if (!data) {
    data = await chatJSON(
      [
        {
          role: 'system',
          content: batched
            ? '你是资深长篇网文策划。只输出合法 JSON，先规划完整分卷，chapters 返回空数组。'
            : '你是资深网文策划。只输出合法 JSON 对象。chapters 数量必须精确等于用户要求的章数。',
        },
        { role: 'user', content: prompt },
      ],
      settings,
      { temperature: 0.8, maxTokens: 8000 }
    );
    if (batched && options.onPlan) await options.onPlan(data);
  }

  let chapters;
  if (batched) {
    chapters = await generateChapterBatches({
      project,
      plan: data,
      startChapter: 1,
      endChapter: project.chapter_count,
      referenceContext,
      existingChapters: options.checkpoint?.chapters || [],
      onBatch: async (partialChapters, range) => {
        if (options.onBatch) {
          await options.onBatch({
            plan: data,
            chapters: partialChapters,
            completedBatches: 1 + Math.ceil(partialChapters.length / OUTLINE_BATCH_SIZE),
            totalBatches: getOutlineBatchCount(project.chapter_count),
            range,
          });
        }
      },
      settings,
    });
  } else {
    chapters = Array.isArray(data.chapters) ? data.chapters : [];
    while (chapters.length < project.chapter_count) {
      const n = chapters.length + 1;
      chapters.push({
        num: n,
        title: `第${n}章`,
        summary: '待细化',
        key_events: [],
        ending_hook: '',
      });
    }
    chapters = chapters.slice(0, project.chapter_count).map((c, i) => ({
      ...c,
      num: i + 1,
      title: c.title || `第${i + 1}章`,
      summary: c.summary || '',
    }));
    if (options.onBatch) {
      await options.onBatch({
        plan: data,
        chapters,
        completedBatches: 1,
        totalBatches: 1,
        range: { batchStart: 1, batchEnd: project.chapter_count },
      });
    }
  }

  return {
    title_suggestion: data.title_suggestion || project.title,
    world: data.world || {},
    characters: data.characters || [],
    timeline: data.timeline || [],
    plot: data.plot || {},
    arcs: data.arcs || [],
    chapters,
  };
}

export async function regenerateContinuationOutline(
  project,
  startChapter,
  newChapterCount,
  instruction,
  settings
) {
  const outline = safeJSON(project.outline_json, {});
  const existingChapters = Array.isArray(outline.chapters) ? outline.chapters : [];
  const prefix = existingChapters.filter((chapter) => Number(chapter.num) < startChapter);
  const chapters = db.listChapters(project.id);
  const priorChapters = chapters.filter((chapter) => chapter.chapter_num < startChapter);
  const priorSummaryRaw = priorChapters
    .map((chapter) => `第${chapter.chapter_num}章《${chapter.title}》：${chapter.summary || chapter.outline}`)
    .join('\n');
  const priorSummary = priorSummaryRaw.length > 9000
    ? `${priorSummaryRaw.slice(0, 1800)}\n...\n${priorSummaryRaw.slice(-7000)}`
    : priorSummaryRaw;
  const previousChapter = priorChapters.at(-1);
  const remainingCount = newChapterCount - startChapter + 1;
  const batched = remainingCount > BATCHED_OUTLINE_THRESHOLD;
  const referenceContext = buildReferenceContext(project);
  const characters = safeJSON(project.characters_json, []);
  const world = safeJSON(project.world_json, {});
  const plot = safeJSON(project.plot_json, {});
  const existingTimeline = Array.isArray(outline.timeline)
    ? outline.timeline
    : safeJSON(project.timeline_json, []);
  const preservedTimeline = existingTimeline.filter((item) => {
    const range = String(item.chapter_range || '');
    const numbers = range.match(/\d+/g)?.map(Number) || [];
    return numbers.length && Math.max(...numbers) < startChapter;
  });

  const prompt = `重新规划《${project.title}》从第${startChapter}章开始的后续章节。
第1章到第${startChapter - 1}章已经发生，绝对不能修改、重写或与其冲突。

输出严格 JSON：
{
  "plot_update": {
    "conflict": "重规划后的后续核心冲突",
    "structure": "后续结构",
    "ending_direction": "新的结局方向",
    "hooks": ["新增或保留的伏笔"]
  },
  "new_characters": [
    {"name":"新增人物","role":"定位","personality":"性格","goal":"目标","arc":"人物弧光"}
  ],
  "timeline": [
    {"time":"后续阶段","event":"事件","chapter_range":"${startChapter}-${newChapterCount}"}
  ],
  "arcs": [
    {"name":"后续篇章/卷名","chapter_range":"${startChapter}-${newChapterCount}","goal":"阶段目标","turning_points":["转折"]}
  ],
  "chapters": [
    {
      "num": ${startChapter},
      "title": "章名",
      "summary": "本章剧情要点 80-150字",
      "key_events": ["事件1"],
      "pov": "视角人物",
      "ending_hook": "章末钩子"
    }
  ]
}

硬性要求：
${batched
    ? '- 这是超长后续：本次先规划 arcs、timeline 和 plot_update，chapters 必须返回空数组 []，逐章大纲将按批次生成'
    : `- chapters 必须正好 ${remainingCount} 项，num 从 ${startChapter} 连续到 ${newChapterCount}`}
- 新的全书总章数为 ${newChapterCount}
- timeline 只规划第${startChapter}章及之后，chapter_range 必须落在新范围内
- 只有确实需要的新人物才放入 new_characters，不要重复已有角色
- 修改要求：${instruction || '延续已有主线，优化后续节奏和因果'}
- 已完成章节摘要：\n${priorSummary || '（从第1章重新规划，无前置章节）'}
- 上一章结尾：\n${previousChapter?.content?.slice(-2500) || '（无）'}
- 主要人物：${JSON.stringify(characters).slice(0, 6000)}
- 世界设定：${JSON.stringify(world).slice(0, 3500)}
- 原剧情方向：${JSON.stringify(plot).slice(0, 3500)}
${referenceContext ? `- 参考作品约束：\n${referenceContext}` : ''}
- 不得让已发生的事件失效；从指定章节自然转向新要求
- 只输出 JSON，不要解释`;

  const data = await chatJSON(
    [
      {
        role: 'system',
        content: batched
          ? '你是长篇小说总编。先规划后续分卷与剧情方向，chapters 返回空数组，只输出合法 JSON。'
          : '你是长篇小说总编，擅长在不改动前文的前提下重构后续章节。只输出合法 JSON。',
      },
      { role: 'user', content: prompt },
    ],
    settings,
    { temperature: 0.75, maxTokens: batched ? 8000 : Math.max(5000, Math.min(16000, remainingCount * 320)) }
  );
  const newCharacters = Array.isArray(data.new_characters) ? data.new_characters : [];
  const characterNames = new Set(characters.map((character) => character.name));
  const mergedCharacters = [
    ...characters,
    ...newCharacters.filter((character) => character?.name && !characterNames.has(character.name)),
  ];
  const updatedPlan = {
    world,
    characters: mergedCharacters,
    plot: { ...plot, ...(data.plot_update || {}) },
    timeline: [...preservedTimeline, ...(Array.isArray(data.timeline) ? data.timeline : [])],
    arcs: data.arcs || [],
  };
  let generated;
  if (batched) {
    generated = await generateChapterBatches({
      project,
      plan: updatedPlan,
      startChapter,
      endChapter: newChapterCount,
      priorChapters: prefix,
      instruction,
      referenceContext,
      settings,
    });
  } else {
    generated = Array.isArray(data.chapters) ? data.chapters : [];
    while (generated.length < remainingCount) {
      const num = startChapter + generated.length;
      generated.push({ num, title: `第${num}章`, summary: '待细化', key_events: [], ending_hook: '' });
    }
    generated = generated.slice(0, remainingCount).map((chapter, index) => ({
      ...chapter,
      num: startChapter + index,
      title: chapter.title || `第${startChapter + index}章`,
      summary: chapter.summary || '',
    }));
  }
  return {
    ...outline,
    ...updatedPlan,
    chapters: [...prefix, ...generated],
  };
}

export async function rebuildGlobalSummaryBefore(projectId, beforeChapter, settings) {
  const chapters = db.listChapters(projectId)
    .filter((chapter) => chapter.chapter_num < beforeChapter && chapter.status === 'done');
  if (!chapters.length) return '';

  const entries = chapters.map((chapter) =>
    `第${chapter.chapter_num}章《${chapter.title}》：${chapter.summary || chapter.outline}`
  );
  const chunks = [];
  let current = '';
  for (const entry of entries) {
    if (current.length + entry.length > 9000 && current) {
      chunks.push(current);
      current = '';
    }
    current += `${entry}\n`;
  }
  if (current) chunks.push(current);

  const partials = [];
  for (const chunk of chunks) {
    partials.push(await chat(
      [
        { role: 'system', content: '将小说章节摘要压缩成连续剧情记忆，保留人物状态、因果、伏笔和时间位置。' },
        { role: 'user', content: `压缩到500字以内：\n${chunk}` },
      ],
      settings,
      { temperature: 0.2, maxTokens: 900 }
    ));
  }
  if (partials.length === 1) return partials[0].trim();
  return (await chat(
    [
      { role: 'system', content: '合并小说分段记忆，保留因果、人物状态、未解伏笔和当前时间线。' },
      { role: 'user', content: `合并为800字以内的全局摘要：\n${partials.join('\n\n')}` },
    ],
    settings,
    { temperature: 0.2, maxTokens: 1400 }
  )).trim();
}

export async function writeChapter(project, chapterNum, settings, { stream = false } = {}) {
  const ctx = buildWritingContext(project, chapterNum);
  const chMeta = db.getChapter(project.id, chapterNum);
  const words = project.words_per_chapter || 2000;

  const system = `你是专业网文作者。根据提供的上下文撰写小说正文。
规则：
1. 只输出小说正文，不要大纲、分析、标题行（除非正文内自然出现）
2. 与上一章结尾自然衔接，人物言行符合设定
3. 落实本章大纲要点，埋下或回收相关伏笔
4. 目标字数约 ${words} 字（允许 ±20%）
5. 文风：${project.style || '现代网文，对话生动，节奏紧凑'}
6. 不要复述全局设定列表；直接写故事`;

  const user = `${ctx}

---
请直接撰写第 ${chapterNum} 章正文。章名可用：${chMeta?.title || ''}。`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  if (stream) {
    const { chatStream } = await import('./llm.js');
    return chatStream(messages, settings, { temperature: 0.85, maxTokens: Math.max(4096, Math.ceil(words * 2.2)) });
  }

  return chat(messages, settings, {
    temperature: 0.85,
    maxTokens: Math.max(4096, Math.ceil(words * 2.2)),
  });
}
