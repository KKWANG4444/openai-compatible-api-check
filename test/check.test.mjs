import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { main } from '../bin/model-api-check.mjs';
import { formatMarkdown, normalizeBaseUrl, runCheck } from '../src/check.mjs';

const apiKey = 'test-secret-key-that-must-never-appear';
const model = 'test-model-v1';
const specialModels = ['nonce-mismatch', 'negative-usage', 'markdown-injection', 'secret-echo'];
let server;
let baseUrl;

before(async () => {
  server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        data: [model, ...specialModels].map((id) => ({ id, object: 'model' })),
      }));
      return;
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const nonce = payload.messages[0].content.split(': ').at(-1);
      const requestedModel = payload.model;

      if (requestedModel === 'secret-echo') {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          model: apiKey,
          choices: [{ message: { content: apiKey } }],
          error: { message: `upstream echoed ${apiKey}` },
        }));
        return;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: requestedModel === 'markdown-injection' ? 'evil|model\n| injected | row |' : requestedModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: requestedModel === 'nonce-mismatch' ? 'wrong-output' : nonce },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: requestedModel === 'negative-usage' ? -1 : 28 },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('标准成功响应生成满分脱敏报告', async () => {
  const report = await runCheck({ baseUrl, model, apiKey, allowInsecureLocalhost: true });
  assert.equal(report.ok, true);
  assert.equal(report.score, 100);
  assert.equal(report.verdict, '兼容良好');
  assert.equal(report.responseModel, model);
  assert.equal(JSON.stringify(report).includes(apiKey), false);
  assert.equal(formatMarkdown(report).includes(apiKey), false);
});

test('恶意上游回显 API Key 时 JSON 和 Markdown 均脱敏', async () => {
  const report = await runCheck({ baseUrl, model: 'secret-echo', apiKey, allowInsecureLocalhost: true });
  const json = JSON.stringify(report);
  const markdown = formatMarkdown(report);
  assert.equal(report.ok, false);
  assert.equal(json.includes(apiKey), false);
  assert.equal(markdown.includes(apiKey), false);
  assert.equal(json.includes('[REDACTED]'), true);
});

test('HTTP 200 但随机 nonce 不匹配时整体判定失败', async () => {
  const report = await runCheck({ baseUrl, model: 'nonce-mismatch', apiKey, allowInsecureLocalhost: true });
  assert.equal(report.checks.find((check) => check.id === 'chat-completions')?.passed, true);
  assert.equal(report.checks.find((check) => check.id === 'instruction-following')?.passed, false);
  assert.equal(report.ok, false);
});

test('负数 Token 不算有效用量', async () => {
  const report = await runCheck({ baseUrl, model: 'negative-usage', apiKey, allowInsecureLocalhost: true });
  assert.equal(report.checks.find((check) => check.id === 'usage')?.passed, false);
});

test('Markdown 动态字段会转义竖线、换行和反斜杠', async () => {
  const report = await runCheck({ baseUrl, model: 'markdown-injection', apiKey, allowInsecureLocalhost: true });
  const markdown = formatMarkdown(report);
  assert.match(markdown, /evil\\\|model\\n\\\| injected \\\| row \\\|/);
  assert.equal(markdown.includes('\n| injected | row |'), false);
});

test('Base URL 拒绝凭据、查询参数和片段', () => {
  assert.throws(() => normalizeBaseUrl('https://user:pass@example.com/v1'), /账号、密码/);
  assert.throws(() => normalizeBaseUrl('https://example.com/v1?token=value'), /查询参数/);
  assert.throws(() => normalizeBaseUrl('https://example.com/v1#section'), /片段/);
});

test('公网地址必须使用 HTTPS', () => {
  assert.throws(() => normalizeBaseUrl('http://example.com/v1'), /HTTPS/);
  assert.equal(normalizeBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
});

test('模型、API Key 与超时参数执行严格校验', async () => {
  await assert.rejects(runCheck({ baseUrl, model: 'bad\nmodel', apiKey, allowInsecureLocalhost: true }), /模型 ID/);
  await assert.rejects(runCheck({ baseUrl, model, apiKey: 'bad\nkey', allowInsecureLocalhost: true }), /API Key/);
  await assert.rejects(runCheck({ baseUrl, model, apiKey, timeoutMs: 999, allowInsecureLocalhost: true }), /超时时间/);
  await assert.rejects(runCheck({ baseUrl, model, apiKey, timeoutMs: 1.5, allowInsecureLocalhost: true }), /超时时间/);
  await assert.rejects(runCheck({ baseUrl, model, apiKey, timeoutMs: 120_001, allowInsecureLocalhost: true }), /超时时间/);
});

test('CLI 根据 report.ok 返回失败码并自动创建嵌套输出目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-api-check-'));
  const outputPath = join(directory, 'reports', 'nested', 'check.md');
  let stdout = '';
  let stderr = '';
  try {
    const exitCode = await main(
      ['--base-url', 'https://example.com/v1', '--model', model, '--output', outputPath],
      { OPENAI_API_KEY: apiKey },
      { stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } } },
      {
        runCheck: async () => ({ ok: false, checks: [] }),
        formatMarkdown: () => '# failed report',
      },
    );
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /报告已写入/);
    assert.equal(await readFile(outputPath, 'utf8'), '# failed report\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
