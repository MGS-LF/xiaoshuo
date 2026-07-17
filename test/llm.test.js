import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chat, chatJSON, extractJSON } from '../server/llm.js';

let server;
let baseUrl;
let attempts = 0;
let mode = 'retry';

before(async () => {
  server = createServer((req, res) => {
    attempts++;
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'retry' && attempts < 3) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'busy' }));
    }
    if (mode === 'bad-request') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'bad request' }));
    }
    if (mode === 'html') {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<!doctype html><title>Website</title>');
    }
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('retries transient errors and succeeds on the third attempt', async () => {
  mode = 'retry';
  attempts = 0;
  const result = await chat(
    [{ role: 'user', content: 'test' }],
    { base_url: baseUrl, model: 'test-model' }
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('does not retry invalid requests', async () => {
  mode = 'bad-request';
  attempts = 0;
  await assert.rejects(
    chat(
      [{ role: 'user', content: 'test' }],
      { base_url: baseUrl, model: 'test-model' }
    ),
    /LLM API 错误 400/
  );
  assert.equal(attempts, 1);
});

test('retries HTML responses and reports an endpoint hint', async () => {
  mode = 'html';
  attempts = 0;
  await assert.rejects(
    chat(
      [{ role: 'user', content: 'test' }],
      { base_url: baseUrl, model: 'test-model' }
    ),
    /HTML.*\/v1/
  );
  assert.equal(attempts, 3);
});

test('repairs unescaped control characters in model JSON', () => {
  const malformed = ['{"summary":"第一行', '第二行","chapters":[]}'].join(String.fromCharCode(10));
  const result = extractJSON(malformed);
  assert.equal(result.summary, ['第一行', '第二行'].join(String.fromCharCode(10)));
  assert.deepEqual(extractJSON('{"title":"第一章" "summary":"漏逗号"}'), {
    title: '第一章',
    summary: '漏逗号',
  });
});

test('retries only the structured request when JSON cannot be repaired', async () => {
  let jsonAttempts = 0;
  global.fetch = async () => {
    jsonAttempts++;
    const content = jsonAttempts === 1 ? 'not json' : '{"chapters":[]}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const data = await chatJSON(
    [{ role: 'user', content: 'return json' }],
    { base_url: 'http://localhost:1', model: 'mock' }
  );
  assert.deepEqual(data, { chapters: [] });
  assert.equal(jsonAttempts, 2);
});
