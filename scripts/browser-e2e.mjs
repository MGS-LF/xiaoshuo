import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xiaoshuo-e2e-'));
const databasePath = path.join(tempDir, 'e2e.db');
const screenshotPath = process.env.E2E_SCREENSHOT || path.join(tempDir, 'outline-progress.png');
const failureScreenshotPath = screenshotPath.replace(/(\.[^.]+)$/, '-failed$1');
const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = edgeCandidates.find(existsSync);
if (!executablePath) throw new Error('未找到 Microsoft Edge，可通过 EDGE_PATH 指定浏览器路径');

const requestLog = [];
let initialPlanCalls = 0;
let failedBatchCalls = 0;

function modelContent(prompt) {
  const range = prompt.match(/第(\d+)章到第(\d+)章/);
  if (!range) {
    initialPlanCalls++;
    return JSON.stringify({
      title_suggestion: '浏览器测试小说',
      world: { setting: '测试世界', rules: '因果连续', tone: '冷峻', locations: [] },
      characters: [{ name: '林默', role: '主角', personality: '谨慎', goal: '查明真相', arc: '接受现实' }],
      timeline: [{ time: '全书', event: '调查主线', chapter_range: '1-55' }],
      plot: { premise: '追查旧案', conflict: '记忆与证据冲突', structure: '三卷', ending_direction: '真相揭晓', hooks: [] },
      arcs: [
        { name: '第一卷', chapter_range: '1-20', goal: '发现疑点' },
        { name: '第二卷', chapter_range: '21-40', goal: '逼近真相' },
        { name: '第三卷', chapter_range: '41-55', goal: '完成收束' },
      ],
      chapters: [],
    });
  }

  const start = Number(range[1]);
  const end = Number(range[2]);
  requestLog.push(`${start}-${end}`);
  if (start === 21 && failedBatchCalls++ < 3) return 'not json';
  return JSON.stringify({
    chapters: Array.from({ length: end - start + 1 }, (_, index) => {
      const num = start + index;
      return {
        num,
        title: `测试标题${num}`,
        summary: `第${num}章推进调查并承接上一章线索。`,
        key_events: [`事件${num}`],
        pov: '林默',
        ending_hook: `钩子${num}`,
      };
    }),
  });
}

const mockServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const prompt = body.messages?.at(-1)?.content || '';
  const content = modelContent(prompt);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

let appProcess;
let browser;
try {
  const mockPort = await listen(mockServer);
  const appPort = await freePort();
  const appUrl = `http://127.0.0.1:${appPort}`;
  appProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(appPort), DATABASE_PATH: databasePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverError = '';
  appProcess.stderr.on('data', (chunk) => { serverError += chunk.toString(); });
  await waitForHealth(appUrl);

  browser = await chromium.launch({
    executablePath,
    headless: process.env.HEADED !== '1',
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

  await page.click('#openSettings');
  await page.fill('#settingsForm [name="base_url"]', `http://127.0.0.1:${mockPort}/v1`);
  await page.fill('#settingsForm [name="model"]', 'mock-model');
  await page.fill('#settingsForm [name="max_tokens"]', '32000');
  await page.click('#settingsForm button[type="submit"]');
  await page.locator('#settingsDialog').waitFor({ state: 'hidden' });

  await page.fill('#createForm [name="title"]', '浏览器进度测试');
  await page.fill('#createForm [name="theme"]', '验证批次失败后从检查点恢复');
  await page.fill('#createForm [name="chapter_count"]', '55');
  await page.fill('#createForm [name="words_per_chapter"]', '1000');
  await page.click('#createForm button[type="submit"]');
  await page.locator('#generateOutline').waitFor();
  await page.click('#generateOutline');

  await page.getByText('当前批次规划失败').waitFor({ timeout: 30000 });
  await page.getByText('2 / 4 · 50%').waitFor();
  await page.screenshot({ path: failureScreenshotPath, fullPage: true });
  assert.equal(initialPlanCalls, 1);
  assert.deepEqual(requestLog, ['1-20', '21-40', '21-40', '21-40']);

  await page.getByRole('button', { name: '重试失败批次' }).click();
  await page.locator('.outline-nav').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '章节大纲 · 55' }).waitFor();
  assert.equal(initialPlanCalls, 1);
  assert.deepEqual(requestLog, [
    '1-20', '21-40', '21-40', '21-40',
    '21-40', '41-55',
  ]);

  const projects = await fetch(`${appUrl}/api/projects`).then((response) => response.json());
  const project = await fetch(`${appUrl}/api/projects/${projects[0].id}`).then((response) => response.json());
  assert.equal(project.status, 'outline_review');
  assert.equal(project.chapters.length, 55);
  assert.equal(project.chapters[0].title, '测试标题1');
  assert.equal(project.chapters[54].title, '测试标题55');

  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    browser: 'Microsoft Edge',
    progressVerified: '2 / 4 · 50%',
    requestLog,
    chapters: project.chapters.length,
    failureScreenshot: failureScreenshotPath,
    screenshot: screenshotPath,
  }));
} finally {
  if (browser) await browser.close();
  if (appProcess && appProcess.exitCode == null) {
    appProcess.kill();
    await Promise.race([
      once(appProcess, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  if (mockServer.listening) await new Promise((resolve) => mockServer.close(resolve));
  if (!process.env.KEEP_E2E_DATA) {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
