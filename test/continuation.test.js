import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import * as db from '../server/db.js';
import { generateOutline, regenerateContinuationOutline } from '../server/context.js';

const projectId = randomUUID();
const originalFetch = global.fetch;

before(() => {
  db.createProject({
    id: projectId,
    title: '重规划测试',
    genre: '悬疑',
    theme: '旧案重查',
    chapter_count: 3,
    words_per_chapter: 1000,
    style: '冷峻',
    extra_prompt: '',
    status: 'writing',
  });
  const outline = {
    world: { setting: '现代城市' },
    characters: [{ name: '林默', role: '主角' }],
    plot: { premise: '追查旧案' },
    chapters: [1, 2, 3].map((num) => ({
      num,
      title: `旧标题${num}`,
      summary: `旧大纲${num}`,
    })),
  };
  db.updateProject(projectId, {
    outline_json: JSON.stringify(outline),
    characters_json: JSON.stringify(outline.characters),
    world_json: JSON.stringify(outline.world),
    plot_json: JSON.stringify(outline.plot),
  });
  for (let num = 1; num <= 3; num++) {
    db.upsertChapter({
      id: randomUUID(),
      project_id: projectId,
      chapter_num: num,
      title: `旧标题${num}`,
      outline: `旧大纲${num}`,
      content: num === 1 ? '必须保留的第一章正文' : '',
      summary: num === 1 ? '第一章摘要' : '',
      status: num === 1 ? 'done' : 'pending',
    });
  }
});

after(() => {
  global.fetch = originalFetch;
  db.deleteProject(projectId);
});

test('replans only chapters at and after the selected chapter', async () => {
  global.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          plot_update: { conflict: '新的双线冲突' },
          new_characters: [{ name: '苏遥', role: '调查员' }],
          timeline: [{ time: '第二阶段', event: '双线调查', chapter_range: '2-4' }],
          chapters: [2, 3, 4].map((num) => ({
            num,
            title: `新标题${num}`,
            summary: `新大纲${num}`,
            key_events: [`新事件${num}`],
            ending_hook: `钩子${num}`,
          })),
        }),
      },
    }],
  }), { headers: { 'Content-Type': 'application/json' } });

  const project = db.getProject(projectId);
  const outline = await regenerateContinuationOutline(
    project,
    2,
    4,
    '从第二章开始改成双线调查',
    { base_url: 'http://localhost:1', model: 'mock' }
  );
  assert.equal(outline.chapters.length, 4);
  assert.equal(outline.chapters[0].title, '旧标题1');
  assert.equal(outline.chapters[1].title, '新标题2');
  assert.equal(outline.chapters[3].title, '新标题4');
  assert.equal(outline.plot.conflict, '新的双线冲突');
  assert.equal(outline.characters.at(-1).name, '苏遥');
  assert.equal(outline.timeline[0].chapter_range, '2-4');

  const replacements = outline.chapters.slice(1).map((chapter) => ({
    id: randomUUID(),
    project_id: projectId,
    chapter_num: chapter.num,
    title: chapter.title,
    outline: chapter.summary,
    content: '',
    summary: '',
    status: 'pending',
  }));
  db.replaceContinuation(projectId, 2, {
    chapter_count: 4,
    outline_json: JSON.stringify(outline),
    status: 'writing',
  }, replacements);

  const chapters = db.listChapters(projectId);
  assert.equal(chapters.length, 4);
  assert.equal(chapters[0].content, '必须保留的第一章正文');
  assert.equal(chapters[0].status, 'done');
  assert.equal(chapters[1].title, '新标题2');
  assert.equal(chapters[3].title, '新标题4');
});

test('generates long outlines in sequential batches', async () => {
  let calls = 0;
  const progress = [];
  global.fetch = async (url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    const prompt = request.messages.at(-1).content;
    const range = prompt.match(/第(\d+)章到第(\d+)章/);
    const content = range
      ? JSON.stringify({
        chapters: Array.from(
          { length: Number(range[2]) - Number(range[1]) + 1 },
          (_, index) => {
            const num = Number(range[1]) + index;
            return { num, title: `长篇标题${num}`, summary: `长篇大纲${num}` };
          }
        ),
      })
      : JSON.stringify({
        title_suggestion: '长篇测试',
        world: { setting: '测试世界' },
        characters: [{ name: '林默', role: '主角' }],
        timeline: [{ time: '全书', event: '主线', chapter_range: '1-81' }],
        plot: { premise: '长篇主线' },
        arcs: [{ name: '第一卷', chapter_range: '1-81', goal: '完成主线' }],
        chapters: [],
      });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const outline = await generateOutline({
    id: randomUUID(),
    title: '长篇测试',
    genre: '玄幻',
    theme: '成长',
    chapter_count: 81,
    words_per_chapter: 1000,
    style: '',
    extra_prompt: '',
    reference_project_id: '',
  }, { base_url: 'http://localhost:1', model: 'mock' }, {
    onPlan: () => progress.push(1),
    onBatch: ({ completedBatches }) => progress.push(completedBatches),
  });

  assert.equal(calls, 6);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6]);
  assert.equal(outline.chapters.length, 81);
  assert.equal(outline.chapters[0].num, 1);
  assert.equal(outline.chapters[80].num, 81);
  assert.equal(outline.chapters[80].title, '长篇标题81');

  calls = 0;
  const resumed = await generateOutline({
    id: randomUUID(),
    title: '长篇测试',
    genre: '玄幻',
    theme: '成长',
    chapter_count: 81,
    words_per_chapter: 1000,
    style: '',
    extra_prompt: '',
    reference_project_id: '',
  }, { base_url: 'http://localhost:1', model: 'mock' }, {
    checkpoint: {
      plan: {
        world: outline.world,
        characters: outline.characters,
        timeline: outline.timeline,
        plot: outline.plot,
        arcs: outline.arcs,
        chapters: [],
      },
      chapters: outline.chapters.slice(0, 40),
    },
  });
  assert.equal(calls, 3);
  assert.equal(resumed.chapters.length, 81);
  assert.equal(resumed.chapters[40].num, 41);
});
