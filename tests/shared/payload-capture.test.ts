// The detail-mode payload capture behind createHttpServer: request/response prefixes
// cut to payloadChars and redacted by key name, nothing captured (and nothing extra
// buffered) while the caller's gate says no, and streamed, range and binary responses
// left completely alone.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Router, badRequest, closeServer, createHttpServer, listen, readBody, readJson, type TraceRequestInfo } from '../../src/shared/node/http.js';
import { REDACTED, normalizeTraceSettings, payloadPrefix, redactPayloadText, type TraceSettings } from '../../src/shared/tracing.js';
import { admin, startAlgorithm, startProvider } from '../helpers.js';

const detailTracing = (payloadChars: number): TraceSettings =>
  normalizeTraceSettings({ enabled: true, payloadChars, levels: { basic: true, detail: true, dependency: true, error: true } });

interface Recorded {
  done: TraceRequestInfo[];
  failed: { info: TraceRequestInfo; error: unknown }[];
}

/** Runs one server with the given routes and trace gate, then reports what was traced. */
async function withServer(
  routes: (router: Router) => void,
  payloadChars: () => number | false,
  body: (base: string) => Promise<void>
): Promise<Recorded> {
  const router = new Router();
  routes(router);
  const record: Recorded = { done: [], failed: [] };
  const server = createHttpServer({
    router,
    name: 'test',
    trace: {
      request: () => 'test-trace',
      payloadChars,
      done: (_traceId, info) => record.done.push(info),
      failed: (_traceId, info, error) => record.failed.push({ info, error }),
    },
  });
  const port = await listen(server, 0, '127.0.0.1');
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    await closeServer(server);
  }
  return record;
}

/** The everyday routes: JSON echo, a JSON reply carrying secrets, and the odd ones. */
function echoRoutes(router: Router): void {
  router.post('/echo', async (ctx) => ({ echo: await readJson(ctx.req) }));
  router.post('/raw', async (ctx) => ({ bytes: (await readBody(ctx.req, 4096)).length }));
  router.get('/secret-reply', () => ({ token: 'abc123', note: 'hi' }));
  router.post('/fail', async (ctx) => {
    await readJson(ctx.req);
    throw badRequest('nope');
  });
  router.get('/hand', (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'application/json' }).end('{"hand":true,"token":"handsecret"}');
    return undefined;
  });
  router.get('/events', (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'text/event-stream' });
    ctx.res.write('data: one\n\n');
    ctx.res.write('data: two\n\n');
    ctx.res.end('data: three\n\n');
    return undefined;
  });
  router.get('/bytes', (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'application/octet-stream' });
    ctx.res.end(Buffer.from([1, 2, 3, 4]));
    return undefined;
  });
  router.get('/ranged', (ctx) => {
    ctx.res.writeHead(206, { 'content-type': 'text/plain', 'content-range': 'bytes 0-3/100' });
    ctx.res.end('abcd');
    return undefined;
  });
}

describe('payload capture', () => {
  it('captures the request/response pair, cut to the limit with an ellipsis', async () => {
    const record = await withServer(echoRoutes, () => 16, async (base) => {
      await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alpha: 'a'.repeat(200) }),
      });
    });
    assert.equal(record.done.length, 1);
    const info = record.done[0];
    assert.ok(info.requestPayload, 'the request body is captured');
    assert.ok(info.responsePayload, 'the response body is captured');
    assert.ok(info.requestPayload.startsWith('{'));
    assert.ok(info.requestPayload.endsWith('…'), 'truncation is marked');
    assert.ok(info.requestPayload.length <= 17, `cut to payloadChars + ellipsis (got ${info.requestPayload.length})`);
    assert.ok(info.responsePayload.endsWith('…'));
    assert.ok(info.responsePayload.length <= 17);
  });

  it('records nothing while the gate says no (tracing off)', async () => {
    for (const gate of [() => false as const, () => 0]) {
      const record = await withServer(echoRoutes, gate, async (base) => {
        await fetch(`${base}/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"password":"hunter2"}',
        });
      });
      assert.equal(record.done.length, 1);
      assert.equal(record.done[0].requestPayload, undefined, 'no request payload');
      assert.equal(record.done[0].responsePayload, undefined, 'no response payload');
    }
  });

  it('redacts secrets by key name, in JSON bodies and query strings alike', async () => {
    const record = await withServer(echoRoutes, () => 2000, async (base) => {
      await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'hunter2', authorization: 'Bearer sekret', Cookie: 'sid=hush', note: 'hi' }),
      });
      await fetch(`${base}/raw`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'x-vs-token=abc123&private_key=shh&note=hi',
      });
      await fetch(`${base}/secret-reply`);
    });
    const [echo, raw, secret] = record.done;
    for (const text of [echo.requestPayload ?? '', echo.responsePayload ?? '', raw.requestPayload ?? '', secret.responsePayload ?? '']) {
      for (const leak of ['hunter2', 'sekret', 'hush', 'abc123', 'shh']) {
        assert.ok(!text.includes(leak), `no ${leak} in "${text}"`);
      }
      assert.ok(text.includes(REDACTED), `redaction marker in "${text}"`);
    }
    assert.ok((echo.requestPayload ?? '').includes('"note":"hi"'), 'non-secret fields stay readable');
    assert.ok((raw.requestPayload ?? '').includes('note=hi'), 'query pairs survive');
    assert.ok((secret.responsePayload ?? '').includes('"note":"hi"'), 'the response keeps its safe fields');
  });

  it('never buffers or breaks streamed, range or binary responses', async () => {
    const record = await withServer(echoRoutes, () => 64, async (base) => {
      const events = await fetch(`${base}/events`);
      const eventsText = await events.text();
      assert.ok(eventsText.includes('one') && eventsText.includes('two') && eventsText.includes('three'), 'every SSE chunk arrives');
      const bytes = new Uint8Array(await (await fetch(`${base}/bytes`)).arrayBuffer());
      assert.deepEqual([...bytes], [1, 2, 3, 4], 'binary bytes arrive untouched');
      const ranged = await fetch(`${base}/ranged`, { headers: { range: 'bytes=0-3' } });
      assert.equal(ranged.status, 206);
      assert.equal(await ranged.text(), 'abcd');
    });
    for (const info of record.done) {
      assert.equal(info.responsePayload, undefined, `nothing captured of ${info.path}`);
    }
  });

  it('captures hand-written JSON replies and error replies too', async () => {
    const record = await withServer(echoRoutes, () => 2000, async (base) => {
      await fetch(`${base}/hand`);
      await fetch(`${base}/fail`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"q":1}',
      });
    });
    const hand = record.done.find((info) => info.path === '/hand');
    assert.ok(hand?.responsePayload?.includes('"hand":true'), 'a reply written by hand is captured');
    assert.ok(!hand?.responsePayload?.includes('handsecret'), 'and redacted the same');
    const failure = record.failed.find((entry) => entry.info.path === '/fail');
    assert.ok(failure, 'the failure is recorded once');
    assert.ok(failure.info.requestPayload?.includes('"q":1'), 'the request side is captured on failures');
    assert.ok(failure.info.responsePayload?.includes('bad_request'), 'the error reply is captured too');
    assert.equal(record.done.length, 1, 'exactly one line per request');
  });
});

describe('payload redaction helpers', () => {
  it('clips with an ellipsis and redacts key names case-insensitively', () => {
    assert.equal(payloadPrefix('x'.repeat(50), 10), `${'x'.repeat(10)}…`);
    assert.equal(payloadPrefix('short', 10), 'short');
    const text = redactPayloadText('{"Password":"p","View-Key":"v","ok":1}');
    assert.ok(!text.includes('"p"') && !text.includes('"v"'));
    assert.ok(text.includes('"ok":1'), 'safe keys are untouched');
    assert.equal(payloadPrefix('token=abc&x=1', 100), `token=${REDACTED}&x=1`);
  });
});

describe('payload capture on nodes', () => {
  it('records the prefixes on an algorithm node, cut to the setting', async () => {
    const node = await startAlgorithm({ tracing: detailTracing(24) });
    try {
      // The secret leads the body, so both the redaction and the cut are visible.
      await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { password: 'hush', contact: 'hello' } });
      const { events } = await admin<{ events: { action: string; data?: { url?: string; requestPayload?: string; responsePayload?: string } }[] }>(
        node.url(),
        '/v1/admin/tracing/events'
      );
      const line = events.find((event) => event.action === 'request ok' && event.data?.url === '/v1/admin/config');
      assert.ok(line, 'the admin call is traced');
      assert.ok(line.data?.requestPayload, 'the request payload is captured');
      assert.ok(line.data.requestPayload.length <= 25, 'cut to payloadChars + ellipsis');
      assert.ok(line.data.requestPayload.endsWith('…'));
      assert.ok(line.data.requestPayload.includes(REDACTED) && !line.data.requestPayload.includes('hush'), 'secrets are redacted');
      assert.ok(line.data?.responsePayload, 'the response payload is captured');
      assert.ok(line.data.responsePayload.endsWith('…'), 'the big config reply is truncated');
    } finally {
      await node.stop();
    }
  });

  it('records nothing on a node while tracing is off', async () => {
    const node = await startAlgorithm();
    try {
      await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { contact: 'hello' } });
      const { events } = await admin<{ events: { data?: Record<string, unknown> }[] }>(node.url(), '/v1/admin/tracing/events');
      assert.ok(
        events.every((event) => event.data?.requestPayload === undefined && event.data?.responsePayload === undefined),
        'tracing off records no payloads (and no events at all)'
      );
    } finally {
      await node.stop();
    }
  });

  it('keeps payloadChars through the settings/config save round-trip', async () => {
    const node = await startAlgorithm();
    try {
      // The same two saves the GUI makes: the tracing tab's form and the config file.
      await admin(node.url(), '/v1/admin/tracing/settings', { method: 'PUT', body: { ...detailTracing(12) } });
      const { settings } = await admin<{ settings: TraceSettings }>(node.url(), '/v1/admin/tracing/settings');
      assert.equal(settings.payloadChars, 12, 'the tracing settings keep it');
      const config = await admin<{ tracing?: TraceSettings }>(node.url(), '/v1/admin/config');
      assert.equal(config.tracing?.payloadChars, 12, 'and it lands in config.tracing for a restart');

      await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { contact: 'hello' } });
      const { events } = await admin<{ events: { action: string; data?: { url?: string; requestPayload?: string } }[] }>(
        node.url(),
        '/v1/admin/tracing/events'
      );
      const line = events.find((event) => event.action === 'request ok' && event.data?.url === '/v1/admin/config');
      assert.ok(line?.data?.requestPayload?.endsWith('…'), 'the saved limit is the one enforced');
      assert.ok((line?.data?.requestPayload?.length ?? 99) <= 13);
    } finally {
      await node.stop();
    }
  });

  it('records the same on a provider node (the shared node-server path)', async () => {
    const node = await startProvider({ tracing: detailTracing(32) });
    try {
      await admin(node.url(), '/v1/admin/config', { method: 'PUT', body: { contact: 'hello' } });
      const { events } = await admin<{ events: { action: string; data?: { url?: string; requestPayload?: string; responsePayload?: string } }[] }>(
        node.url(),
        '/v1/admin/tracing/events'
      );
      const line = events.find((event) => event.action === 'request ok' && event.data?.url === '/v1/admin/config');
      assert.ok(line?.data?.requestPayload && line.data.responsePayload, 'both payloads captured on the provider too');
      assert.ok(line.data.requestPayload.length <= 33 && line.data.responsePayload.length <= 33);
    } finally {
      await node.stop();
    }
  });
});
