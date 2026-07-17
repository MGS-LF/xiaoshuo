import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chat } from '../server/llm.js';

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
