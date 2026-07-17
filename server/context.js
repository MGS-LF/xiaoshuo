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
import { chat, extractJSON } from './llm.js';
import * as db from './db.js';

const RECENT_FULL_CHAPTERS = 1;
const RECENT_SUMMARY_CHAPTERS = 5;

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

  const raw = await chat(
    [
      { role: 'system', content: '你只输出合法 JSON，不要 markdown 代码块外的说明。' },
      { role: 'user', content: prompt },
    ],
    settings,
    { temperature: 0.3, maxTokens: 1500 }
  );

  let parsed;
  try {
    parsed = extractJSON(raw);
  } catch {
    return { summary: raw.slice(0, 500), memories: [] };
  }

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

export async function generateOutline(project, settings) {
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
- 总章数：${project.chapter_count}（chapters 数组必须正好 ${project.chapter_count} 项，num 从 1 到 ${project.chapter_count}）
- 每章约 ${project.words_per_chapter || 2000} 字量级的情节密度
- 文风偏好：${project.style || '流畅网文，画面感强'}
- 额外要求：${project.extra_prompt || '无'}
- 人物 4-8 个主要角色即可
- 时间线覆盖全书节奏
- 章节之间因果连贯，有起承转合与爽点/张力节奏`;

  const raw = await chat(
    [
      {
        role: 'system',
        content: '你是资深网文策划。只输出合法 JSON 对象。chapters 数量必须精确等于用户要求的章数。',
      },
      { role: 'user', content: prompt },
    ],
    settings,
    { temperature: 0.8, maxTokens: 8000 }
  );

  const data = extractJSON(raw);

  // 规范化 chapters
  let chapters = data.chapters || [];
  if (!Array.isArray(chapters)) chapters = [];
  // 若不足则补空
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

  return {
    title_suggestion: data.title_suggestion || project.title,
    world: data.world || {},
    characters: data.characters || [],
    timeline: data.timeline || [],
    plot: data.plot || {},
    chapters,
  };
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
