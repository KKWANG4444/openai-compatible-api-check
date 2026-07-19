import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function loadActionMetadata() {
  const script = `
require 'json'
require 'yaml'
metadata = YAML.load_file('action.yml')
puts JSON.generate(metadata)
`;
  return JSON.parse(execFileSync('ruby', ['-e', script], { cwd: repositoryRoot, encoding: 'utf8' }));
}

test('Docker action passes every declared input through runs.args', () => {
  const metadata = loadActionMetadata();
  assert.deepEqual(metadata.runs.args, [
    '${{ inputs.base-url }}',
    '${{ inputs.model }}',
    '${{ inputs.api-key }}',
    '${{ inputs.timeout }}',
    '${{ inputs.report-path }}',
  ]);
});

test('Docker action entrypoint reads positional arguments, not unavailable INPUT variables', async () => {
  const entrypoint = await readFile(new URL('../action/entrypoint.sh', import.meta.url), 'utf8');
  assert.match(entrypoint, /base_url="\$\{1:-\}"/);
  assert.match(entrypoint, /api_key="\$\{3:-\}"/);
  assert.doesNotMatch(entrypoint, /INPUT_BASE_URL|INPUT_API_KEY/);
});

test('Docker base image is pinned by digest for reproducible builds', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^FROM node:20-alpine@sha256:[a-f0-9]{64}$/m);
});
