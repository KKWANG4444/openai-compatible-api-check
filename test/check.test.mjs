import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMainModule, main, parseArgs } from '../bin/model-api-check.mjs';
import { assertPublicHostname, createPublicLookup, formatMarkdown, isPublicIpAddress, normalizeBaseUrl, parseJsonObject, protocolFrom, runCheck, usageFrom } from '../src/check.mjs';

const apiKey = 'test-secret-key-that-must-never-appear';
const model = 'test-model-v1';
const specialModels = ['nonce-mismatch', 'negative-usage', 'usage-mismatch', 'challenge-mismatch', 'markdown-injection', 'secret-echo', 'second-usage', 'second-negative', 'second-missing-usage', 'second-model', 'second-protocol', 'second-metadata', 'second-http', 'usage-overflow', 'redirect', 'timeout'];
let redirectHits = 0;
let server;
let baseUrl;

before(async () => {
  server = createServer(async (request, response) => {
    if (request.url === '/redirect-target') {
      redirectHits += 1;
      response.writeHead(500).end();
      return;
    }
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
      const prompt = payload.messages[0].content;
      const requestedModel = payload.model;
      const isChallenge = prompt.startsWith('R1 dynamic challenge:');

      if (requestedModel === 'redirect') {
        response.writeHead(307, { Location: '/redirect-target' }).end();
        return;
      }
      if (requestedModel === 'timeout') return;

      if (requestedModel === 'secret-echo') {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          model: apiKey,
          choices: [{ message: { content: apiKey } }],
          error: { message: `upstream echoed ${apiKey}` },
        }));
        return;
      }

      let content;
      if (isChallenge) {
        const values = prompt.match(/starts at (\d+), receives (\d+) boxes with (\d+) items each, then ships (\d+)/)?.slice(1).map(Number);
        const challengeNonce = prompt.match(/"nonce":"([a-f0-9]+)"/)?.[1];
        const answer = values ? values[0] + values[1] * values[2] - values[3] : null;
        content = JSON.stringify({
          answer: requestedModel === 'challenge-mismatch' ? answer + 1 : answer,
          nonce: challengeNonce,
        });
      } else {
        const nonce = prompt.split(': ').at(-1);
        content = requestedModel === 'nonce-mismatch' ? 'wrong-output' : nonce;
      }

      response.writeHead(isChallenge && requestedModel === 'second-http' ? 500 : 200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_test_123' });
      const data = {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1_784_000_000,
        model: requestedModel === 'markdown-injection' ? 'evil|model\n| injected | row |' : requestedModel,
        system_fingerprint: 'fp_test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 8,
          total_tokens: requestedModel === 'negative-usage' ? -1 : requestedModel === 'usage-mismatch' ? 31 : 28,
        },
      };
      if (requestedModel === 'usage-overflow') data.usage = { prompt_tokens: Number.MAX_SAFE_INTEGER - 1, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER };
      if (isChallenge) {
        if (requestedModel === 'second-usage') data.usage.total_tokens = 999;
        if (requestedModel === 'second-negative') data.usage.total_tokens = -1;
        if (requestedModel === 'second-missing-usage') delete data.usage;
        if (requestedModel === 'second-model') data.model = 'wrong-model';
        if (requestedModel === 'second-protocol') { delete data.object; delete data.created; }
        if (requestedModel === 'second-metadata') { delete data.id; delete data.model; }
      }
      response.end(JSON.stringify(data));
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
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.generator.version, '1.0.6');
  assert.equal(report.requestCount, 3);
  assert.equal(report.usage.total, 56);
  assert.equal(report.signals.systemFingerprint, 'fp_test');
  assert.equal(report.checks.find((check) => check.id === 'dynamic-challenge')?.passed, true);
  assert.equal(JSON.stringify(report).includes(apiKey), false);
  assert.equal(formatMarkdown(report).includes(apiKey), false);
  assert.equal(formatMarkdown(report).includes('https://docs.aifast.hk/model-check/'), true);
  assert.doesNotMatch(formatMarkdown(report), /aifast\.(?:club|link)/i);
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

test('负数 Token 会让整体部署门禁失败', async () => {
  const report = await runCheck({ baseUrl, model: 'negative-usage', apiKey, allowInsecureLocalhost: true });
  assert.equal(report.checks.find((check) => check.id === 'usage')?.passed, false);
  assert.equal(report.ok, false);
});

test('Token 总数不满足输入加输出时会让整体部署门禁失败', async () => {
  const report = await runCheck({ baseUrl, model: 'usage-mismatch', apiKey, allowInsecureLocalhost: true });
  assert.equal(report.checks.find((check) => check.id === 'usage')?.passed, false);
  assert.equal(report.ok, false);
});

test('R1 动态题答案错误时整体判定失败', async () => {
  const report = await runCheck({ baseUrl, model: 'challenge-mismatch', apiKey, allowInsecureLocalhost: true });
  assert.equal(report.checks.find((check) => check.id === 'instruction-following')?.passed, true);
  assert.equal(report.checks.find((check) => check.id === 'dynamic-challenge')?.passed, false);
  assert.equal(report.ok, false);
});

for (const [model, checkId] of [
  ['second-usage', 'usage'], ['second-negative', 'usage'], ['second-missing-usage', 'usage'],
  ['second-model', 'model-claim'], ['second-protocol', 'protocol'], ['second-metadata', 'metadata'],
  ['second-http', 'chat-completions'], ['usage-overflow', 'usage'],
]) {
  test(`第二次响应或汇总异常不能通过：${model}`, async () => {
    const report = await runCheck({ baseUrl, model, apiKey, allowInsecureLocalhost: true });
    assert.equal(report.ok, false);
    assert.equal(report.verdict, '需要排查');
    assert.ok(report.score < 100);
    assert.equal(report.checks.find(check => check.id === checkId).passed, false);
    if (checkId === 'usage') assert.deepEqual(report.usage, { input: null, output: null, total: null });
  });
}

test('拒绝跟随重定向且不向目标发送凭据', async () => {
  const report = await runCheck({ baseUrl, model: 'redirect', apiKey, allowInsecureLocalhost: true });
  assert.equal(report.ok, false);
  assert.equal(redirectHits, 0);
  assert.match(report.checks.find(check => check.id === 'chat-completions').detail, /307/);
});

test('网络超时会终止请求并生成失败报告', async () => {
  const report = await runCheck({ baseUrl, model: 'timeout', apiKey, timeoutMs: 1000, allowInsecureLocalhost: true });
  assert.equal(report.ok, false);
  assert.match(report.checks.find(check => check.id === 'chat-completions').detail, /请求超时/);
});

test('协议与 usage 辅助函数严格核对结构和算术', () => {
  assert.equal(protocolFrom({ id: 'x', object: 'chat.completion', created: 1, choices: [{ message: {}, finish_reason: 'stop' }] }).passed, true);
  assert.equal(protocolFrom({ choices: [] }).passed, false);
  assert.deepEqual(usageFrom({ usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }), {
    input: 3,
    output: 2,
    total: 5,
    present: true,
    arithmeticValid: true,
  });
  assert.equal(usageFrom({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 9 } }).arithmeticValid, false);
});

test('动态题 JSON 允许代码围栏但拒绝非对象', () => {
  assert.deepEqual(parseJsonObject('```json\n{"answer":42,"nonce":"abc"}\n```'), { answer: 42, nonce: 'abc' });
  assert.equal(parseJsonObject('[1,2,3]'), null);
  assert.equal(parseJsonObject('not-json'), null);
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

test('Base URL 拒绝本机、私网和保留地址', () => {
  for (const value of [
    'https://127.0.0.1/v1',
    'https://10.0.0.8/v1',
    'https://192.168.1.8/v1',
    'https://[::1]/v1',
    'https://gateway.local/v1',
    'https://service.internal/v1',
  ]) {
    assert.throws(() => normalizeBaseUrl(value), /公网地址/);
  }
});

test('公网 IP 分类覆盖 IPv4、IPv6 和 IPv4-mapped IPv6', () => {
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicIpAddress('10.0.0.1'), false);
  assert.equal(isPublicIpAddress('169.254.1.1'), false);
  assert.equal(isPublicIpAddress('2001:db8::1'), false);
  assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false);
  for (const address of ['::ffff:7f00:1', '0:0:0:0:0:ffff:0a00:0001', '::ffff:a9fe:a9fe', '0:0:0:0:0:0:0:1', '2001:0db8:0:0::1', '64:ff9b::a00:1', '2002:0a00:0001::1', 'fe80::1%en0']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  for (const address of ['::ffff:808:808', '0:0:0:0:0:ffff:8.8.8.8', '2001:4860:4860::8888']) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
});

test('完整检测入口拒绝规范化后的映射私网地址，不触发请求', async () => {
  for (const address of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:7f00:1']) {
    await assert.rejects(runCheck({ baseUrl: `https://[${address}]/v1`, model, apiKey }), /公网地址/);
  }
  assert.throws(() => normalizeBaseUrl('https://10.0.0.1/v1', true), /公网地址/);
  assert.throws(() => normalizeBaseUrl('ftp://localhost/v1', true), /HTTPS/);
});

test('连接时只使用同次已校验的 DNS 地址并拒绝重新绑定到私网', async () => {
  let calls = 0;
  const guarded = createPublicLookup(async () => {
    calls += 1;
    return calls === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '::ffff:7f00:1', family: 6 }];
  });
  const resolve = () => new Promise((resolve, reject) => guarded('gateway.example', { all: true }, (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(await resolve(), [{ address: '8.8.8.8', family: 4 }]);
  await assert.rejects(resolve(), /私网或保留地址/);
  assert.equal(calls, 2);
});

test('连接解析兼容单地址回调，并拒绝混合和空结果', async () => {
  const guarded = createPublicLookup(async () => [{ address: '2606:4700:4700::1111', family: 6 }]);
  await new Promise((resolve, reject) => guarded('gateway.example', {}, (error, address, family) => {
    if (error) return reject(error);
    assert.equal(address, '2606:4700:4700::1111'); assert.equal(family, 6); resolve();
  }));
  for (const records of [[], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    const lookup = createPublicLookup(async () => records);
    await assert.rejects(new Promise((resolve, reject) => lookup('gateway.example', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))), /私网或保留地址/);
  }
});

test('域名解析结果包含私网地址时拒绝检测', async () => {
  await assert.doesNotReject(assertPublicHostname('public.example', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]));
  await assert.rejects(assertPublicHostname('mixed.example', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.9', family: 4 },
  ]), /私网或保留地址/);
  await assert.rejects(assertPublicHostname('missing.example', async () => {
    throw new Error('ENOTFOUND');
  }), /无法解析/);
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

test('CLI 支持常见的 -h 帮助参数', () => {
  assert.deepEqual(parseArgs(['-h']), { help: true });
});

test('CLI 支持版本参数', async () => {
  let stdout = '';
  const status = await main(['--version'], {}, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: () => {} },
  });
  assert.equal(status, 0);
  assert.equal(stdout, '1.0.6\n');
});

test('CLI 通过符号链接启动时仍能识别主模块', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-api-check-link-'));
  const cliPath = fileURLToPath(new URL('../bin/model-api-check.mjs', import.meta.url));
  const linkedPath = join(directory, 'model-api-check');
  try {
    await symlink(cliPath, linkedPath);
    assert.equal(isMainModule(linkedPath), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
