import { randomInt, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const WEB_CHECK_URL = 'https://docs.aifast.hk/model-check/';
const REPORT_SCHEMA_URL = 'https://raw.githubusercontent.com/KKWANG4444/openai-compatible-api-check/main/schema/report.schema.json';
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

// BlockList 使用二进制地址比较，同时覆盖点分、十六进制和展开的 IPv4 映射地址。
const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blockedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) blockedAddresses.addSubnet(address, prefix, 'ipv6');
const publicIpv6Ranges = new BlockList();
publicIpv6Ranges.addSubnet('2000::', 3, 'ipv6');
publicIpv6Ranges.addSubnet('::ffff:0:0', 96, 'ipv6');

function isPublicIpAddress(address) {
  const normalized = String(address ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized.includes('%')) return false;
  const version = isIP(normalized);
  if (version === 4) return !blockedAddresses.check(normalized, 'ipv4');
  return version === 6 && publicIpv6Ranges.check(normalized, 'ipv6')
    && !blockedAddresses.check(normalized, 'ipv6');
}

function isPrivateHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.home.arpa')
    || (isIP(normalized) > 0 && !isPublicIpAddress(normalized));
}

async function assertPublicHostname(hostname, resolve = lookup) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isPrivateHostname(normalized)) throw new Error('Base URL 必须指向公网地址');
  if (isIP(normalized)) return;

  let records;
  try {
    records = await resolve(normalized, { all: true, verbatim: true });
  } catch {
    throw new Error('Base URL 域名无法解析');
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error('Base URL 域名无法解析');
  if (records.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('Base URL 域名解析到了私网或保留地址');
  }
}

function createPublicLookup(resolve = lookup) {
  return (hostname, options, callback) => {
    if (isPrivateHostname(hostname)) {
      callback(new Error('Base URL 必须指向公网地址'));
      return;
    }
    // 将此次连接实际使用的解析结果交回 socket，不再另做一次未校验的 DNS 查询。
    resolve(hostname, { ...options, all: true, verbatim: true }).then((records) => {
      if (!records.length || records.some(({ address, family }) => !isPublicIpAddress(address) || isIP(address) !== family)) {
        throw new Error('Base URL 域名解析到了私网或保留地址');
      }
      return records;
    }).then((records) => {
      if (options.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    }, (error) => callback(error));
  };
}
const publicLookup = createPublicLookup();

function normalizeBaseUrl(value, allowInsecureLocalhost = false) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Base URL 不是有效 URL');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLocalhost = ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  const allowLocal = allowInsecureLocalhost && isLocalhost;
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) {
    throw new Error('Base URL 必须使用 HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 不能包含账号、密码、查询参数或片段');
  }
  if (!allowLocal && isPrivateHostname(hostname)) {
    throw new Error('Base URL 必须指向公网地址');
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

async function requestJson(url, options, timeoutMs, allowLocal = false) {
  const startedAt = Date.now();
  try {
    const { response, text } = await new Promise((resolve, reject) => {
      const target = new URL(url);
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      let timer;
      const req = request(target, {
        method: options.method, headers: options.headers, agent: false,
        lookup: allowLocal ? undefined : publicLookup,
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) req.destroy(new Error('响应超过 8 MiB 限制'));
          else chunks.push(chunk);
        });
        response.on('error', (error) => { clearTimeout(timer); reject(error); });
        response.on('end', () => { clearTimeout(timer); resolve({ response, text: Buffer.concat(chunks).toString('utf8') }); });
      });
      req.on('error', (error) => { clearTimeout(timer); reject(error); });
      timer = setTimeout(() => req.destroy(new Error('请求超时')), timeoutMs);
      req.end(options.body);
    });
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    const ok = response.statusCode >= 200 && response.statusCode < 300;
    return {
      ok,
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
      requestId: response.headers['x-request-id'] || response.headers['request-id'] || null,
      contentType: response.headers['content-type'] || null,
      data,
      error: ok ? null : String(data?.error?.message || text || response.statusMessage).slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      requestId: null,
      contentType: null,
      data: null,
      error: String(error),
    };
  }
}

async function requestText(url, options, timeoutMs, allowLocal = false) {
  const startedAt = Date.now();
  try {
    const { response, text, firstByteMs } = await new Promise((resolve, reject) => {
      const target = new URL(url);
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      let timer;
      let firstByteAt = null;
      const req = request(target, {
        method: options.method, headers: options.headers, agent: false,
        lookup: allowLocal ? undefined : publicLookup,
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (firstByteAt === null) firstByteAt = Date.now();
          size += chunk.length;
          if (size > 8 * 1024 * 1024) req.destroy(new Error('响应超过 8 MiB 限制'));
          else chunks.push(chunk);
        });
        response.on('error', (error) => { clearTimeout(timer); reject(error); });
        response.on('end', () => clearTimeout(timer) || resolve({
          response,
          text: Buffer.concat(chunks).toString('utf8'),
          firstByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
        }));
      });
      req.on('error', (error) => { clearTimeout(timer); reject(error); });
      timer = setTimeout(() => req.destroy(new Error('请求超时')), timeoutMs);
      req.end(options.body);
    });
    const ok = response.statusCode >= 200 && response.statusCode < 300;
    return {
      ok,
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
      firstByteMs,
      requestId: response.headers['x-request-id'] || response.headers['request-id'] || null,
      contentType: response.headers['content-type'] || null,
      text,
      error: ok ? null : text.slice(0, 240) || String(response.statusMessage),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      firstByteMs: null,
      requestId: null,
      contentType: null,
      text: '',
      error: String(error),
    };
  }
}

function parseSse(text) {
  const events = [];
  const parseErrors = [];
  let done = false;
  let eventName = null;
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0 && eventName === null) return;
    const data = dataLines.join('\n');
    const event = { event: eventName, data, json: null };
    if (data === '[DONE]') {
      done = true;
    } else if (data) {
      try {
        event.json = JSON.parse(data);
      } catch {
        parseErrors.push(data.slice(0, 160));
      }
    }
    events.push(event);
    eventName = null;
    dataLines = [];
  };

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line === '') {
      flush();
    } else if (line.startsWith(':')) {
      continue;
    } else if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();
  return { events, done, parseErrors, jsonEvents: events.filter((event) => event.json !== null) };
}

function parseToolArguments(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function percentile(values, percentileRank) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileRank) - 1));
  return sorted[index];
}

async function runThoroughChecks({ normalizedBaseUrl, requestedModel, authorization, reportNonce, timeoutMs, allowLocal, chat, challenge }) {
  const stream = await requestText(endpoint(normalizedBaseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: requestedModel,
      temperature: 0,
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: `SSE probe ${reportNonce}: reply with one short sentence.` }],
    }),
  }, timeoutMs, allowLocal);
  const parsedStream = parseSse(stream.text);
  const streamChunks = parsedStream.jsonEvents.map((event) => event.json);
  const validChunks = streamChunks.filter((chunk) => (
    typeof chunk?.id === 'string'
    && Array.isArray(chunk?.choices)
    && ((chunk.choices.length === 0 && chunk.usage && typeof chunk.usage === 'object')
      || (chunk.choices.length > 0
        && typeof chunk.choices[0] === 'object'
        && (chunk.choices[0].delta === undefined || typeof chunk.choices[0].delta === 'object')))
  ));
  const hasDelta = streamChunks.some((chunk) => chunk?.choices?.some((choice) => (
    choice?.delta && typeof choice.delta === 'object'
      && (typeof choice.delta.content === 'string' || choice.delta.tool_calls !== undefined || choice.delta.role !== undefined)
  )));
  const hasFinishReason = streamChunks.some((chunk) => chunk?.choices?.some((choice) => typeof choice?.finish_reason === 'string'));
  const streamPassed = stream.ok
    && /text\/event-stream/i.test(stream.contentType || '')
    && parsedStream.done
    && parsedStream.parseErrors.length === 0
    && streamChunks.length > 0
    && validChunks.length === streamChunks.length
    && hasDelta
    && hasFinishReason;

  const toolName = 'aifast_probe';
  const tool = await requestJson(endpoint(normalizedBaseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: requestedModel,
      temperature: 0,
      max_tokens: 64,
      tool_choice: { type: 'function', function: { name: toolName } },
      tools: [{ type: 'function', function: {
        name: toolName,
        description: 'Return the provided probe value without calling any external service.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      } }],
      messages: [{ role: 'user', content: `Call ${toolName} exactly once with value "${reportNonce}".` }],
    }),
  }, timeoutMs, allowLocal);
  const toolMessage = tool.data?.choices?.[0]?.message;
  const modernCall = Array.isArray(toolMessage?.tool_calls)
    ? toolMessage.tool_calls.find((call) => call?.type === 'function' && call?.function?.name === toolName)
    : null;
  const legacyCall = toolMessage?.function_call?.name === toolName ? toolMessage.function_call : null;
  const selectedCall = modernCall?.function || legacyCall;
  const toolArguments = parseToolArguments(selectedCall?.arguments);
  const toolPassed = tool.ok && Boolean(selectedCall) && toolArguments?.value === reportNonce;

  const invalidModel = `${requestedModel.slice(0, 120)}__aifast_invalid_${reportNonce}`;
  const errorProbe = await requestJson(endpoint(normalizedBaseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: invalidModel,
      temperature: 0,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'This request must fail because the model ID is intentionally invalid.' }],
    }),
  }, timeoutMs, allowLocal);
  const errorObject = errorProbe.data?.error;
  const errorPassed = !errorProbe.ok
    && errorProbe.status >= 400
    && errorProbe.status < 500
    && errorObject
    && typeof errorObject === 'object'
    && typeof errorObject.message === 'string'
    && !JSON.stringify(errorObject).includes(authorization.Authorization.replace('Bearer ', ''));

  const latencySamples = [chat.durationMs, challenge.durationMs, stream.durationMs];
  const advancedChecks = [
    {
      id: 'sse-stream',
      name: 'SSE 流式事件',
      passed: streamPassed,
      detail: streamPassed
        ? `收到 ${streamChunks.length} 个合法事件，已收到 [DONE]，首事件 ${stream.firstByteMs ?? '未知'} ms`
        : `HTTP ${stream.status}；事件 ${streamChunks.length}；解析错误 ${parsedStream.parseErrors.length}；[DONE] ${parsedStream.done ? '有' : '无'}；Content-Type ${stream.contentType || '未知'}`,
    },
    {
      id: 'tool-call-schema',
      name: '工具调用结构',
      passed: toolPassed,
      detail: toolPassed
        ? `工具 ${toolName} 返回可解析 JSON 参数（${modernCall ? 'tool_calls' : 'function_call'}）`
        : `HTTP ${tool.status}；未获得带正确函数名和 JSON 参数的工具调用${tool.error ? `：${tool.error}` : ''}`,
    },
    {
      id: 'error-contract',
      name: '错误响应契约',
      passed: errorPassed,
      detail: errorPassed
        ? `故意使用不存在模型得到 HTTP ${errorProbe.status}，且返回结构化 error.message`
        : `故意错误模型得到 HTTP ${errorProbe.status}，未满足 4xx 结构化错误响应`,
    },
  ];
  const passed = advancedChecks.filter((check) => check.passed).length;
  return {
    profile: 'thorough',
    requestCount: 3,
    score: Math.round((passed / advancedChecks.length) * 100),
    checks: advancedChecks,
    latency: {
      samples: latencySamples,
      sampleCount: latencySamples.filter((value) => Number.isFinite(value)).length,
      p50Ms: percentile(latencySamples, 0.5),
      p95Ms: percentile(latencySamples, 0.95),
      streamFirstByteMs: stream.firstByteMs,
      note: '这是本次检测的少量样本，不代表长期可用性或 SLA。',
    },
  };
}

function responseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((item) => typeof item?.text === 'string' ? item.text : '').join('').trim();
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageFrom(data) {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') {
    return { input: null, output: null, total: null, present: false, arithmeticValid: false };
  }
  const input = integerOrNull(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens);
  const output = integerOrNull(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.outputTokens);
  const total = integerOrNull(usage.total_tokens ?? usage.totalTokens);
  const present = [input, output, total].some((value) => value !== null);
  const arithmeticValid = input !== null && output !== null && total !== null && input + output === total;
  return { input, output, total, present, arithmeticValid };
}

function protocolFrom(data) {
  const signals = {
    id: typeof data?.id === 'string' && data.id.length > 0,
    object: typeof data?.object === 'string' && data.object.length > 0,
    created: Number.isSafeInteger(data?.created) && data.created >= 0,
    choices: Array.isArray(data?.choices) && data.choices.length > 0,
    message: Boolean(data?.choices?.[0]?.message && typeof data.choices[0].message === 'object'),
    finishReason: typeof data?.choices?.[0]?.finish_reason === 'string',
  };
  const passedCount = Object.values(signals).filter(Boolean).length;
  return { signals, passedCount, totalCount: Object.keys(signals).length, passed: passedCount >= 5 && signals.choices && signals.message };
}

function metadataFrom(data, requestedModel, requestId) {
  const responseModel = typeof data?.model === 'string' ? data.model : null;
  const systemFingerprint = typeof data?.system_fingerprint === 'string' ? data.system_fingerprint.slice(0, 160) : null;
  const available = [
    typeof data?.id === 'string',
    typeof data?.object === 'string',
    Number.isSafeInteger(data?.created),
    responseModel !== null,
    typeof requestId === 'string',
  ].filter(Boolean).length;
  return {
    responseModel,
    systemFingerprint,
    requestId,
    exactModel: responseModel === requestedModel,
    available,
    total: 5,
  };
}

function parseJsonObject(value) {
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

const REQUIRED_CHECK_IDS = [
  'models-endpoint',
  'model-listed',
  'chat-completions',
  'protocol',
  'instruction-following',
  'metadata',
  'model-claim',
  'usage',
  'dynamic-challenge',
];

function requiredChecksPassed(checks) {
  if (!Array.isArray(checks) || checks.length !== REQUIRED_CHECK_IDS.length) return false;
  const byId = new Map(checks.map((check) => [check?.id, check]));
  return byId.size === REQUIRED_CHECK_IDS.length
    && REQUIRED_CHECK_IDS.every((id) => byId.get(id)?.passed === true);
}

function scoreVerdict(score) {
  if (score >= 85) return '兼容良好';
  if (score >= 65) return '部分兼容';
  return '需要排查';
}

export async function runCheck({
  baseUrl,
  model,
  apiKey,
  timeoutMs = 30_000,
  allowInsecureLocalhost = false,
  profile = 'quick',
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
  if (!['quick', 'thorough'].includes(profile)) throw new Error('检测档只能是 quick 或 thorough');

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, allowInsecureLocalhost);
  const allowLocal = allowInsecureLocalhost && ['127.0.0.1', 'localhost', '::1'].includes(new URL(normalizedBaseUrl).hostname.replace(/^\[|\]$/g, ''));
  if (!allowLocal) {
    await assertPublicHostname(new URL(normalizedBaseUrl).hostname);
  }
  const authorization = { Authorization: `Bearer ${normalizedApiKey}` };
  const reportNonce = randomUUID().replaceAll('-', '').slice(0, 16);
  const instructionToken = `AIFAST_CHECK_${reportNonce}`;

  const models = await requestJson(endpoint(normalizedBaseUrl, '/models'), {
    method: 'GET',
    headers: authorization,
  }, timeoutMs, allowLocal);
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
      messages: [{ role: 'user', content: `Reply with exactly this text and nothing else: ${instructionToken}` }],
    }),
  }, timeoutMs, allowLocal);

  const basicOutput = responseText(chat.data);
  const instructionPassed = basicOutput === instructionToken;
  const protocol = protocolFrom(chat.data);
  const metadata = metadataFrom(chat.data, requestedModel, chat.requestId);
  const basicUsage = usageFrom(chat.data);

  const initial = randomInt(31, 91);
  const boxes = randomInt(3, 10);
  const perBox = randomInt(4, 13);
  const shipped = randomInt(7, 28);
  const expectedAnswer = initial + boxes * perBox - shipped;
  const challenge = await requestJson(endpoint(normalizedBaseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: requestedModel,
      temperature: 0,
      max_tokens: 96,
      messages: [{
        role: 'user',
        content: `R1 dynamic challenge: inventory starts at ${initial}, receives ${boxes} boxes with ${perBox} items each, then ships ${shipped}. Output JSON only: {"answer":integer,"nonce":"${reportNonce}"}`,
      }],
    }),
  }, timeoutMs, allowLocal);
  const challengeJson = parseJsonObject(responseText(challenge.data));
  const challengePassed = challenge.ok
    && challengeJson?.answer === expectedAnswer
    && challengeJson?.nonce === reportNonce;
  const challengeUsage = usageFrom(challenge.data);
  const challengeProtocol = protocolFrom(challenge.data);
  const challengeMetadata = metadataFrom(challenge.data, requestedModel, challenge.requestId);
  const usageValid = basicUsage.arithmeticValid && challengeUsage.arithmeticValid;
  const totalUsage = usageValid ? {
    input: basicUsage.input + challengeUsage.input,
    output: basicUsage.output + challengeUsage.output,
    total: basicUsage.total + challengeUsage.total,
  } : { input: null, output: null, total: null };
  const totalsValid = usageValid && Object.values(totalUsage).every(Number.isSafeInteger)
    && totalUsage.input + totalUsage.output === totalUsage.total;
  if (!totalsValid) Object.assign(totalUsage, { input: null, output: null, total: null });

  const checks = [
    { id: 'models-endpoint', name: '模型列表接口', passed: models.ok, weight: 10, detail: models.ok ? `HTTP ${models.status}` : models.error },
    { id: 'model-listed', name: '模型 ID 可发现', passed: modelIds.includes(requestedModel), weight: 5, detail: modelIds.length ? `返回 ${modelIds.length} 个模型` : '未获得可用模型列表' },
    { id: 'chat-completions', name: 'Chat Completions 调用', passed: chat.ok && challenge.ok, weight: 15, detail: `首次 HTTP ${chat.status}，${chat.error || `${chat.durationMs} ms`}；动态题 HTTP ${challenge.status}，${challenge.error || `${challenge.durationMs} ms`}` },
    { id: 'protocol', name: '协议层合规', passed: protocol.passed && challengeProtocol.passed, weight: 15, detail: `首次关键字段 ${protocol.passedCount}/${protocol.totalCount}；动态题 ${challengeProtocol.passedCount}/${challengeProtocol.totalCount}` },
    { id: 'instruction-following', name: '固定指令遵循', passed: instructionPassed, weight: 15, detail: instructionPassed ? '随机字符串原样返回' : '返回内容与随机字符串不一致' },
    { id: 'metadata', name: '元数据指纹', passed: metadata.available >= 4 && challengeMetadata.available >= 4, weight: 10, detail: `首次元数据 ${metadata.available}/${metadata.total}；动态题 ${challengeMetadata.available}/${challengeMetadata.total}` },
    { id: 'model-claim', name: '响应模型声明一致', passed: metadata.exactModel && challengeMetadata.exactModel, weight: 10, detail: `首次 model: ${metadata.responseModel ?? '未返回'}；动态题 model: ${challengeMetadata.responseModel ?? '未返回'}` },
    { id: 'usage', name: '计费 Token 字段', passed: totalsValid, weight: 10, detail: totalsValid ? `两次均通过，合计输入 ${totalUsage.input} + 输出 ${totalUsage.output} = 总计 ${totalUsage.total}` : `首次 usage ${basicUsage.arithmeticValid ? '通过' : '缺失或算术错误'}；动态题 usage ${challengeUsage.arithmeticValid ? '通过' : '缺失或算术错误'}；汇总不可用` },
    { id: 'dynamic-challenge', name: 'R1 动态题', passed: challengePassed, weight: 10, detail: challengePassed ? '随机多步计算与 nonce 均通过' : challenge.ok ? '答案或 nonce 未通过精确校验' : challenge.error },
  ];
  const score = checks.reduce((total, check) => total + (check.passed ? check.weight : 0), 0);
  const ok = requiredChecksPassed(checks);
  const advanced = profile === 'thorough'
    ? await runThoroughChecks({ normalizedBaseUrl, requestedModel, authorization, reportNonce, timeoutMs, allowLocal, chat, challenge })
    : null;
  const report = {
    $schema: REPORT_SCHEMA_URL,
    schemaVersion: 2,
    reportId: `aifast-check-${reportNonce}`,
    generator: { name: 'openai-compatible-api-check', version: '1.1.0', mode: profile },
    ok,
    checkedAt: new Date().toISOString(),
    baseUrl: normalizedBaseUrl,
    requestedModel,
    responseModel: metadata.responseModel,
    score,
    verdict: ok ? scoreVerdict(score) : '需要排查',
    requestCount: 3 + (advanced?.requestCount || 0),
    usage: totalUsage,
    signals: {
      systemFingerprint: metadata.systemFingerprint,
      requestId: metadata.requestId,
      protocolFields: protocol.signals,
    },
    checks,
    ...(advanced ? { advanced } : {}),
    disclaimer: '本报告是检测时点的 OpenAI Compatible 协议、元数据、Token 与行为抽样结果，不是模型厂商认证，也不能单独证明底层模型身份。请结合多轮测试、真实业务题集、成本和稳定性判断。',
  };

  return redactValue(report, [apiKey, normalizedApiKey]);
}

export function formatMarkdown(report) {
  const rows = report.checks.map((check) => `| ${markdownInline(check.name)} | ${check.passed ? '通过' : '未通过'} | ${markdownInline(check.detail || '-')} |`);
  const usage = report.usage?.total === null || report.usage?.total === undefined
    ? '未完整返回'
    : `${report.usage.total}（输入 ${report.usage.input} / 输出 ${report.usage.output}）`;
  const advancedRows = report.advanced?.checks?.length
    ? [
      '',
      '## 深度兼容性证据',
      '',
      `- 检测档：${markdownInline(report.advanced.profile)}`,
      `- 深度证据分：${markdownInline(report.advanced.score)}/100`,
      `- 延迟样本：p50 ${markdownInline(report.advanced.latency?.p50Ms ?? '未知')} ms；p95 ${markdownInline(report.advanced.latency?.p95Ms ?? '未知')} ms；首个 SSE 事件 ${markdownInline(report.advanced.latency?.streamFirstByteMs ?? '未知')} ms`,
      '',
      '| 深度检查项 | 结果 | 证据 |',
      '| --- | --- | --- |',
      ...report.advanced.checks.map((check) => `| ${markdownInline(check.name)} | ${check.passed ? '通过' : '未通过'} | ${markdownInline(check.detail || '-')} |`),
      '',
      `> ${markdownInline(report.advanced.latency?.note || '深度检测同样只是一次性样本。')}`,
    ]
    : [];
  return [
    '# OpenAI Compatible API 自检报告',
    '',
    `- 报告 ID：${markdownInline(report.reportId)}`,
    `- 检测时间：${markdownInline(report.checkedAt)}`,
    `- Base URL：${markdownInline(report.baseUrl)}`,
    `- 请求模型：${markdownInline(report.requestedModel)}`,
    `- 响应模型：${markdownInline(report.responseModel ?? '未返回')}`,
    `- 请求 / Token：${markdownInline(report.requestCount)} 次 / ${markdownInline(usage)}`,
    `- 综合兼容度：${markdownInline(report.score)}/100（${markdownInline(report.verdict)}）`,
    '',
    '| 检查项 | 结果 | 证据 |',
    '| --- | --- | --- |',
    ...rows,
    ...advancedRows,
    '',
    `> ${markdownInline(report.disclaimer)}`,
    '',
    `更完整的网页检测（输出风格、知识 cutoff、SSE、工具调用）：${WEB_CHECK_URL}`,
  ].join('\n');
}

export { assertPublicHostname, createPublicLookup, isPublicIpAddress, markdownInline, normalizeBaseUrl, parseJsonObject, parseSse, protocolFrom, requiredChecksPassed, usageFrom };
