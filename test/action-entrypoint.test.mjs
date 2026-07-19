import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const entrypoint = join(repositoryRoot, 'action', 'entrypoint.sh');
const apiKey = 'action-test-secret';
const model = 'action-test-model';
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
      response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
      return;
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const prompt = payload.messages[0].content;
      let content;
      if (prompt.startsWith('R1 dynamic challenge:')) {
        const values = prompt.match(/starts at (\d+), receives (\d+) boxes with (\d+) items each, then ships (\d+)/)?.slice(1).map(Number);
        const nonce = prompt.match(/"nonce":"([a-f0-9]+)"/)?.[1];
        content = JSON.stringify({ answer: values[0] + values[1] * values[2] - values[3], nonce });
      } else {
        content = prompt.split(': ').at(-1);
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_action_test' });
      response.end(JSON.stringify({
        id: 'chatcmpl-action-test', object: 'chat.completion', created: 1_784_000_000, model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function runAction({ environment = {}, cwd }) {
  const args = [
    environment.INPUT_BASE_URL ?? baseUrl,
    environment.INPUT_MODEL ?? model,
    environment.INPUT_API_KEY ?? apiKey,
    environment.INPUT_TIMEOUT ?? '30000',
    environment.INPUT_REPORT_PATH ?? 'reports/openai-compatible-api-check.md',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(entrypoint, args, {
      cwd,
      env: {
        ...process.env,
        MODEL_API_CHECK_ROOT: repositoryRoot,
        GITHUB_WORKSPACE: cwd,
        MODEL_API_CHECK_ALLOW_INSECURE_LOCALHOST: '1',
        ...environment,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('GitHub Action entrypoint writes a report and action outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-api-check-action-'));
  const outputFile = join(directory, 'github-output.txt');
  const summaryFile = join(directory, 'summary.md');
  try {
    await chmod(entrypoint, 0o755);
    const result = await runAction({
      cwd: directory,
      environment: { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(join(directory, 'reports/openai-compatible-api-check.md'), 'utf8'), /兼容良好/);
    assert.match(await readFile(outputFile, 'utf8'), /report-path=reports\/openai-compatible-api-check\.md/);
    assert.match(await readFile(outputFile, 'utf8'), /result=passed/);
    assert.match(await readFile(summaryFile, 'utf8'), /OpenAI Compatible API Check/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action entrypoint rejects a missing API key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-api-check-action-missing-key-'));
  try {
    const result = await runAction({ cwd: directory, environment: { INPUT_API_KEY: '' } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /api-key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action entrypoint keeps report output inside the workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-api-check-action-path-'));
  try {
    for (const reportPath of ['/tmp/outside.md', '../outside.md']) {
      const result = await runAction({ cwd: directory, environment: { INPUT_REPORT_PATH: reportPath } });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /report-path/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
