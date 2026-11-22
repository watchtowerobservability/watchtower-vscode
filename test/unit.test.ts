import assert from 'node:assert';
import { test } from 'vitest';
import * as c from '../src/core';

const event: c.IssueEvent = {
  trace_id: 'abc123',
  exception: { values: [{ stacktrace: { frames: [
    { filename: '/srv/app/node_modules/x/index.js', lineno: 9, function: 'lib' },
    { filename: '/srv/app/src/cart.js', lineno: 42, function: 'total' },
  ] } }] },
};

test('framesOf returns innermost first and drops frames without a line', () => {
  const f = c.framesOf({ frames: [{ filename: 'a.js', lineno: 1 }, { filename: 'b.js' }, { filename: 'c.js', lineno: 3 }] });
  assert.deepStrictEqual(f.map((x) => x.file), ['c.js', 'a.js']);
  assert.deepStrictEqual(c.framesOf(undefined), []);
});

test('sameFile matches absolute, URL and windows paths by suffix', () => {
  assert.ok(c.sameFile('/srv/app/src/cart.js', 'src/cart.js'));
  assert.ok(c.sameFile('https://x.test/src/cart.js?v=1', 'src/cart.js'));
  assert.ok(c.sameFile('C:\\app\\src\\cart.js', 'src/cart.js'));
  assert.ok(!c.sameFile('/srv/app/src/other.js', 'src/cart.js'));
  assert.ok(!c.sameFile('/srv/app/mycart.js', 'cart.js'));
});

test('issuesForFile picks the matching frame and the trace id', () => {
  const r = c.issuesForFile([{ issue: { id: 'i1' }, event }, { issue: { id: 'i2' }, event: {} }], 'src/cart.js');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0]?.frame.line, 42);
  assert.strictEqual(r[0]?.traceId, 'abc123');
});

test('hotFunctions filters by file and threshold, heaviest first', () => {
  const rows = [
    { name: 'root', file: 'src/main.js', total: 100, self: 1 },
    { name: 'a', file: '/x/src/cart.js', total: 40, self: 30, line: 7 },
    { name: 'b', file: '/x/src/cart.js', total: 10, self: 6 },
    { name: 'c', file: '/x/src/cart.js', total: 2, self: 2 },
  ];
  const h = c.hotFunctions(rows, 'src/cart.js', 5);
  assert.deepStrictEqual(h.map((x) => [x.name, Math.round(x.pct)]), [['a', 30], ['b', 6]]);
  assert.deepStrictEqual(c.hotFunctions([], 'x'), []);
});

test('locateFunction uses the line, else finds the definition', () => {
  assert.strictEqual(c.locateFunction({ name: 'f', line: 5 }, ''), 5);
  assert.strictEqual(c.locateFunction({ name: 'Cart.total', line: 0 }, 'x\nfunction total(a) {\n}'), 2);
  assert.strictEqual(c.locateFunction({ name: 'nope', line: 0 }, 'x'), 0);
});

test('client sends the bearer token, never leaks it in errors or string form', async () => {
  const calls: [string, string | undefined][] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push([url, init.headers.Authorization]);
    return { ok: false, status: 404, json: async () => ({ detail: 'not found' }) };
  };
  const cl = c.createClient({ apiUrl: 'https://api.test/', projectId: 'prj 1', token: 'wta_secretsecret', fetchImpl });
  await assert.rejects(cl.issues(5), (e) => {
    assert.match(e.message, /404: not found/);
    assert.ok(!e.message.includes('wta_secretsecret'));
    return true;
  });
  assert.strictEqual(calls[0]?.[0], 'https://api.test/v1/projects/prj%201/issues?limit=5&status=unresolved');
  assert.strictEqual(calls[0]?.[1], 'Bearer wta_secretsecret');
  assert.ok(!String(cl).includes('secretsecret'));
  assert.throws(() => c.createClient({ apiUrl: '', projectId: 'p', token: 't' }), /required/);
});

test('links build project urls', () => {
  assert.strictEqual(c.links('https://w.test/', 'p1').trace('t/1'), 'https://w.test/projects/p1/traces/t%2F1');
});

test('logSites finds logger calls across languages', () => {
  const src = 'x = 1\nlogger.info("a")\n  console.error(e)\ntracing::warn!("w")\nfoo()\nlog.Printf("p")\n';
  assert.deepStrictEqual(c.logSites(src), [1, 2, 3, 5]);
  assert.deepStrictEqual(c.logSites(src, 2), [1, 2]);
});

test('logs search matches the code location and titles the volume', async () => {
  let sent: { url: string; body: string } | undefined;
  const api = c.createClient({
    apiUrl: 'https://api.example', projectId: 'p1', token: 'tok',
    fetchImpl: (async (url: string, init: { body?: string }) => {
      sent = { url, body: String(init.body) };
      return { ok: true, status: 200, json: async () => ({ data: [{ body: 'boom', severity_text: 'ERROR' }] }) };
    }) as never,
  });
  const hits = await api.logs('api', { file: 'src/a.ts', line: 7 });
  assert.ok(sent!.url.endsWith('/v1/projects/p1/logs/search'));
  const b = JSON.parse(sent!.body);
  assert.deepStrictEqual(b.services, ['api']);
  assert.deepStrictEqual(b.attrs, [{ key: 'code.filepath', op: 'contains', value: 'src/a.ts' }, { key: 'code.lineno', op: 'eq', value: '7' }]);
  assert.strictEqual(c.logsTitle(hits), '1 log lines/24h');
  assert.strictEqual(c.logsTitle({ data: [], next_cursor: 'x' }), '0+ log lines/24h');
  assert.ok(c.links('https://w', 'p1').logs('api', { file: 'a', line: 1 }).startsWith('https://w/projects/p1/logs?q='));
});

test('Kotlin stack frames map to the .kt source file', () => {
  const ev: c.IssueEvent = { exception: { values: [{ stacktrace: { frames: [
    { filename: 'Cart.kt', lineno: 12, function: 'io.app.Cart.total' },
  ] } }] } };
  const hit = c.issuesForFile([{ issue: { id: 'i1' }, event: ev }], 'src/main/kotlin/io/app/Cart.kt');
  assert.strictEqual(hit[0]?.frame.line, 12);
});

test('literalOf keeps the longest fixed part of the template', () => {
  assert.strictEqual(c.literalOf('log.Printf("payment failed for user %s, retrying", id)'), 'payment failed for user');
  assert.strictEqual(c.literalOf('logger.info("Order {} shipped late", o)'), 'shipped late');
  assert.strictEqual(c.literalOf('log.Println("ok")'), '');
  assert.ok(c.links('https://w', 'p1').logs('api', { file: 'a', line: 1 }, 'shipped late').includes(encodeURIComponent('"text":"shipped late"')));
});
