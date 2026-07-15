#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMarkdown, runCheck } from '../src/check.mjs';

function usage() {
  return `model-api-check

用法：
  model-api-check --base-url https://api.example.com/v1 --model MODEL_ID [选项]

选项：
  --key-env NAME       API Key 环境变量名，默认 OPENAI_API_KEY
  --format FORMAT      markdown 或 json，默认 markdown
  --output FILE        将报告写入文件；默认输出到终端
  --timeout MS         单次请求超时，默认 30000，范围 1000-120000
  --help               显示帮助

安全说明：
  工具不接受命令行明文 Key，避免密钥进入 shell history。`;
}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--help') return { help: true };
    if (!current.startsWith('--')) throw new Error(`无法识别参数：${current}`);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${current} 缺少参数值`);
    values.set(current.slice(2), next);
    index += 1;
  }
  return Object.fromEntries(values);
}

export async function writeOutput(path, output) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output, 'utf8');
}

export function isMainModule(argvPath, moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
  io = { stdout: process.stdout, stderr: process.stderr },
  dependencies = { runCheck, formatMarkdown },
) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }

    const keyEnv = args['key-env'] || 'OPENAI_API_KEY';
    const format = args.format || 'markdown';
    if (!args['base-url'] || !args.model) throw new Error('必须提供 --base-url 和 --model');
    if (!['markdown', 'json'].includes(format)) throw new Error('--format 只能是 markdown 或 json');
    const apiKey = environment[keyEnv];
    if (!apiKey) throw new Error(`环境变量 ${keyEnv} 未设置`);

    const report = await dependencies.runCheck({
      baseUrl: args['base-url'],
      model: args.model,
      apiKey,
      timeoutMs: Number(args.timeout || 30_000),
    });
    const output = format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${dependencies.formatMarkdown(report)}\n`;

    if (args.output) {
      await writeOutput(args.output, output);
      io.stderr.write(`报告已写入 ${args.output}\n`);
    } else {
      io.stdout.write(output);
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${usage()}\n`);
    return 2;
  }
}

if (isMainModule(process.argv[1])) {
  process.exitCode = await main();
}
