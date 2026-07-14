import { randomUUID } from 'node:crypto';

const WEB_CHECK_URL = 'https://docs.aifast.club/model-check/';
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function normalizeBaseUrl(value, allowInsecureLocalhost = false) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Base URL 不是有效 URL');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLocalhost = ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && isLocalhost)) {
    throw new Error('Base URL 必须使用 HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 不能包含账号、密码、查询参数或片段');
  }
  return url.toString().replace(/\/$/, '');
}

function endpoint(baseUrl, path) {
  return `${baseUrl}${path}`;
}

function redactString(value, secrets) {
  let output = String(value ?? '');
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, '[REDACTED]');
  }
  return output;
}

function redactValue(value, secrets) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  }
  return value;
}

function markdownInline(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      data,
      error: response.ok ? null : String(data?.error?.message || text || response.statusText).slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      data: null,
      error: error instanceof Error && error.name === 'AbortError' ? '请求超时' : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function responseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((item) => typeof item?.text === 'string' ? item.text : '').join('').trim();
}

function usageAvailable(data) {
  const value = data?.usage?.total_tokens ?? data?.usage?.totalTokens;
  return Number.isSafeInteger(value) && value >= 0;
}

export async function runCheck({
  baseUrl,
  model,
  apiKey,
  timeoutMs = 30_000,
  allowInsecureLocalhost = false,
}) {
  const requestedModel = typeof model === 'string' ? model.trim() : '';
  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!requestedModel || requestedModel.length > 180 || /[\u0000-\u001f\u007f-\u009f]/.test(requestedModel)) {
    throw new Error('模型 ID 格式无效');
  }
  if (!normalizedApiKey || /[\r\n]/.test(apiKey)) throw new Error('API Key 格式无效');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`超时时间必须是 ${MIN_TIMEOUT_MS} 到 ${MAX_TIMEOUT_MS} 之间的整数毫秒值`);
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, allowInsecureLocalhost);
  const authorization = { Authorization: `Bearer ${normalizedApiKey}` };
  const nonce = `AIFAST_CHECK_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  const models = await requestJson(endpoint(normalizedBaseUrl, '/models'), {
    method: 'GET',
    headers: authorization,
  }, timeoutMs);
  const modelIds = Array.isArray(models.data?.data)
    ? models.data.data.map((item) => item?.id).filter((id) => typeof id === 'string')
    : [];

  const chat = await requestJson(endpoint(normalizedBaseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: requestedModel,
      temperature: 0,
      max_tokens: 64,
      messages: [{ role: 'user', content: `Reply with exactly this text and nothing else: ${nonce}` }],
    }),
  }, timeoutMs);

  const output = responseText(chat.data);
  const instructionPassed = output === nonce;
  const actualModel = typeof chat.data?.model === 'string' ? chat.data.model : null;
  const checks = [
    { id: 'models-endpoint', name: '模型列表接口', passed: models.ok, weight: 15, detail: models.ok ? `HTTP ${models.status}` : models.error },
    { id: 'model-listed', name: '模型 ID 可发现', passed: modelIds.includes(requestedModel), weight: 10, detail: modelIds.length ? `返回 ${modelIds.length} 个模型` : '未获得可用模型列表' },
    { id: 'chat-completions', name: 'Chat Completions 调用', passed: chat.ok, weight: 30, detail: chat.ok ? `HTTP ${chat.status}，${chat.durationMs} ms` : chat.error },
    { id: 'instruction-following', name: '固定指令遵循', passed: instructionPassed, weight: 20, detail: instructionPassed ? '随机字符串原样返回' : '返回内容与随机字符串不一致' },
    { id: 'model-claim', name: '响应模型声明一致', passed: actualModel === requestedModel, weight: 15, detail: actualModel ? `响应 model: ${actualModel}` : '响应未提供 model 字段' },
    { id: 'usage', name: 'Token 用量字段', passed: usageAvailable(chat.data), weight: 10, detail: usageAvailable(chat.data) ? '返回非负整数 total_tokens' : '未返回可核对的非负整数 total_tokens' },
  ];
  const score = checks.reduce((total, check) => total + (check.passed ? check.weight : 0), 0);
  const report = {
    schemaVersion: 1,
    ok: chat.ok && instructionPassed,
    checkedAt: new Date().toISOString(),
    baseUrl: normalizedBaseUrl,
    requestedModel,
    responseModel: actualModel,
    score,
    verdict: score >= 85 ? '兼容良好' : score >= 65 ? '部分兼容' : '需要排查',
    requestCount: 2,
    checks,
    disclaimer: '本报告是一次 OpenAI Compatible 黑盒冒烟测试，不是模型厂商认证，也不能单独证明底层模型身份。请结合多轮测试、真实业务题集、成本和稳定性判断。',
  };

  return redactValue(report, [apiKey, normalizedApiKey]);
}

export function formatMarkdown(report) {
  const rows = report.checks.map((check) => `| ${markdownInline(check.name)} | ${check.passed ? '通过' : '未通过'} | ${markdownInline(check.detail || '-')} |`);
  return [
    '# OpenAI Compatible API 自检报告',
    '',
    `- 检测时间：${markdownInline(report.checkedAt)}`,
    `- Base URL：${markdownInline(report.baseUrl)}`,
    `- 请求模型：${markdownInline(report.requestedModel)}`,
    `- 响应模型：${markdownInline(report.responseModel ?? '未返回')}`,
    `- 综合兼容度：${markdownInline(report.score)}/100（${markdownInline(report.verdict)}）`,
    '',
    '| 检查项 | 结果 | 证据 |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `> ${markdownInline(report.disclaimer)}`,
    '',
    `更完整的网页检测（SSE、工具调用、动态题与 Token 证据）：${WEB_CHECK_URL}`,
  ].join('\n');
}

export { markdownInline, normalizeBaseUrl };
