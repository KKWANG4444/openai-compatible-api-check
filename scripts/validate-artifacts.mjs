import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const readText = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const schema = await readJson('../schema/report.schema.json');
const example = await readJson('../examples/report.example.json');
const postman = await readJson('../postman/OpenAI-Compatible-API-Smoke-Test.postman_collection.json');
const [readme, methodology, reportSchema, llms, llmsFull] = await Promise.all([
  readText('../README.md'),
  readText('../docs/methodology.md'),
  readText('../docs/report-schema.md'),
  readText('../llms.txt'),
  readText('../llms-full.txt'),
]);

const fail = (message) => {
  throw new Error(`产物校验失败：${message}`);
};

if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('JSON Schema 版本错误');

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateReport = ajv.compile(schema);
if (!validateReport(example)) {
  fail(`示例报告不符合 Schema：${ajv.errorsText(validateReport.errors, { separator: '；' })}`);
}

if (example.schemaVersion !== 2 || example.generator?.version !== '0.2.2') fail('示例报告版本错误');
if (example.$schema !== schema.$id) fail('示例报告未指向当前 Schema');
if (!Array.isArray(example.checks) || example.checks.length !== 9) fail('示例报告必须包含 9 项检查');

const ids = example.checks.map((check) => check.id);
if (new Set(ids).size !== ids.length) fail('示例报告检查项 ID 重复');
if (example.checks.reduce((sum, check) => sum + check.weight, 0) !== 100) fail('示例报告权重总计不是 100');
if (example.score !== example.checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0)) fail('示例报告分数与单项结果不一致');
if (example.usage.input + example.usage.output !== example.usage.total) fail('示例报告 Token 算术不一致');

const serializedExample = JSON.stringify(example).toLowerCase();
for (const marker of ['sk-', 'bearer ', 'api_key', 'apikey']) {
  if (serializedExample.includes(marker)) fail(`示例报告疑似包含密钥标记 ${marker}`);
}

if (!postman?.info?.name || !Array.isArray(postman.item) || postman.item.length < 2) fail('Postman Collection 结构无效');
const postmanScripts = postman.item
  .flatMap((item) => item.event ?? [])
  .flatMap((event) => event.script?.exec ?? [])
  .join('\n');
if (!postmanScripts.includes("data.model).to.eql(pm.collectionVariables.get('model'))")) {
  fail('Postman 未精确校验响应模型声明');
}
if (!postmanScripts.includes('data.usage.total_tokens).to.eql(input + output)')) {
  fail('Postman 未校验 Token 算术');
}

const requiredUrls = [
  'https://docs.aifast.club/model-check/',
  'https://github.com/KKWANG4444/openai-compatible-api-check',
];
for (const [name, content] of Object.entries({ readme, methodology, reportSchema, llms, llmsFull })) {
  if (!content.trim()) fail(`${name} 为空`);
}
for (const url of requiredUrls) {
  if (!readme.includes(url) || !llms.includes(url) || !llmsFull.includes(url)) fail(`关键入口缺失：${url}`);
}

console.log('产物校验通过：Schema、示例报告、方法论、Postman 与机器可读入口一致。');
