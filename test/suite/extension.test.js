'use strict';
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

const demo = path.resolve(__dirname, '..', '..', 'examples', 'demo');

suite('Watchtower extension', () => {
  let server;
  let seenAuth;

  suiteSetup(async () => {
    server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v1/projects/p1/issues/i1/events')) {
        res.end(JSON.stringify({ data: [{
          trace_id: 't1',
          exception: { values: [{ stacktrace: { frames: [
            { filename: '/ci/build/src/cart.js', lineno: 2, function: 'total' },
          ] } }] },
        }] }));
      } else if (req.url.startsWith('/v1/projects/p1/issues')) {
        res.end(JSON.stringify({ data: [{ id: 'i1', title: 'TypeError in total', times_seen: 7 }] }));
      } else if (req.url.startsWith('/v1/projects/p1/profiles/table')) {
        res.end(JSON.stringify({ data: [
          { name: 'total', file: 'src/cart.js', line: 1, self: 50, total: 80 },
          { name: 'main', file: 'src/main.js', self: 1, total: 100 },
        ] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const c = vscode.workspace.getConfiguration('watchtower');
    await c.update('apiUrl', `http://127.0.0.1:${server.address().port}`, vscode.ConfigurationTarget.Global);
    await c.update('projectId', 'p1', vscode.ConfigurationTarget.Global);
    await c.update('service', 'cart', vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(() => server.close());

  test('registers its commands', async () => {
    const ext = vscode.extensions.getExtension('watchtowerobservability.watchtower-vscode');
    await ext.activate();
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['signIn', 'signOut', 'refresh', 'openIssue', 'openTrace', 'openReplay']) {
      assert.ok(cmds.includes(`watchtower.${c}`), c);
    }
  });

  test('shows the issue as a diagnostic on its stack frame line and a hot-function lens', async () => {
    const api = await vscode.extensions.getExtension('watchtowerobservability.watchtower-vscode').activate();
    await api.setToken('wta_test');
    const doc = await vscode.workspace.openTextDocument(path.join(demo, 'src', 'cart.js'));
    await vscode.window.showTextDocument(doc);
    await api.refresh();

    const ds = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'Watchtower');
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].range.start.line, 1);
    assert.match(ds[0].message, /TypeError in total/);
    assert.strictEqual(seenAuth, 'Bearer wta_test');

    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    const titles = lenses.map((l) => l.command.title);
    assert.ok(titles.some((t) => t.includes('TypeError in total')), titles.join('|'));
    assert.ok(titles.includes('Trace'));
    assert.ok(titles.some((t) => t.includes('62.5% of CPU')), titles.join('|'));
  });

  test('sign out clears diagnostics', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(demo, 'src', 'cart.js'));
    await vscode.commands.executeCommand('watchtower.signOut');
    assert.strictEqual(vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'Watchtower').length, 0);
  });
});
