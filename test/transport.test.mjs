import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { runCheck } from '../src/check.mjs';

test('HTTPS 请求保留目标主机、TLS 默认校验并使用受控 DNS 回调', async (t) => {
  const calls = [];
  const mock = t.mock.method(https, 'request', (target, options, onResponse) => {
    calls.push({ target, options });
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 401;
      response.statusMessage = 'Unauthorized';
      response.headers = { 'content-type': 'application/json' };
      onResponse(response);
      response.emit('data', Buffer.from('{"error":{"message":"offline unauthorized"}}'));
      response.emit('end');
    });
    return req;
  });
  syncBuiltinESMExports();
  try {
    const report = await runCheck({ baseUrl: 'https://8.8.8.8/v1', model: 'offline-model', apiKey: 'offline-placeholder' });
    assert.equal(report.ok, false);
    assert.equal(calls.length, 3);
    for (const { target, options } of calls) {
      assert.equal(target.protocol, 'https:');
      assert.equal(target.hostname, '8.8.8.8');
      assert.equal(options.rejectUnauthorized, undefined);
      assert.equal(options.checkServerIdentity, undefined);
      assert.equal(options.agent, false);
      assert.equal(typeof options.lookup, 'function');
      await assert.rejects(new Promise((resolve, reject) => options.lookup('localhost', { all: true }, (error, records) => error ? reject(error) : resolve(records))), /公网地址/);
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
