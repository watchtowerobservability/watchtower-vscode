'use strict';
const vscode = require('vscode');
const core = require('./core.js');

const SECRET = 'watchtower.apiToken';
const cfg = () => vscode.workspace.getConfiguration('watchtower');

/** Per-file state: issues with a frame in the file, and hot functions from profiles. */
let state = { issues: new Map(), hot: [] };

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('watchtower');
  const changed = new vscode.EventEmitter();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = 'watchtower.refresh';

  const client = async () => {
    const token = await context.secrets.get(SECRET);
    const c = cfg();
    const apiUrl = c.get('apiUrl');
    const projectId = c.get('projectId');
    if (!token || !apiUrl || !projectId) return undefined;
    return { api: core.createClient({ apiUrl, projectId, token }), apiUrl, projectId, c };
  };
  const linkBase = (x) => core.links(x.c.get('webUrl') || x.apiUrl, x.projectId);

  async function refresh() {
    const x = await client();
    if (!x) {
      status.text = '$(eye) Watchtower: sign in';
      status.show();
      return;
    }
    try {
      status.text = '$(sync~spin) Watchtower';
      status.show();
      const list = (await x.api.issues(x.c.get('maxIssues') || 30)).data ?? [];
      const entries = await Promise.all(list.map(async (issue) => ({
        issue, event: await x.api.latestEvent(issue.id).catch(() => undefined),
      })));
      state = { issues: new Map(), hot: [], entries };
      const service = x.c.get('service');
      if (service) state.profile = (await x.api.profileTable(service).catch(() => ({ data: [] }))).data;
      status.text = `$(eye) Watchtower: ${list.length} issues`;
    } catch (e) {
      status.text = '$(warning) Watchtower';
      vscode.window.showWarningMessage(e.message);
    }
    changed.fire();
    publishDiagnostics();
  }

  const relPath = (doc) => vscode.workspace.asRelativePath(doc.uri, false);

  function issuesIn(doc) {
    return core.issuesForFile(state.entries ?? [], relPath(doc));
  }

  function publishDiagnostics() {
    diagnostics.clear();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file') continue;
      const ds = issuesIn(doc).map(({ issue, frame }) => {
        const line = Math.min(Math.max(frame.line - 1, 0), Math.max(doc.lineCount - 1, 0));
        const d = new vscode.Diagnostic(
          doc.lineAt(line).range,
          `${issue.title ?? 'Issue'} (seen ${issue.times_seen ?? '?'}x)`,
          vscode.DiagnosticSeverity.Warning,
        );
        d.source = 'Watchtower';
        d.code = issue.id;
        return d;
      });
      diagnostics.set(doc.uri, ds);
    }
  }

  const lenses = {
    onDidChangeCodeLenses: changed.event,
    async provideCodeLenses(doc) {
      const out = [];
      for (const { issue, frame, traceId, replayId } of issuesIn(doc)) {
        const range = new vscode.Range(Math.max(frame.line - 1, 0), 0, Math.max(frame.line - 1, 0), 0);
        out.push(new vscode.CodeLens(range, {
          title: `$(bug) ${issue.title ?? issue.id}`, command: 'watchtower.openIssue', arguments: [issue.id],
        }));
        if (traceId) out.push(new vscode.CodeLens(range, { title: 'Trace', command: 'watchtower.openTrace', arguments: [traceId] }));
        if (replayId) out.push(new vscode.CodeLens(range, { title: 'Replay', command: 'watchtower.openReplay', arguments: [replayId] }));
      }
      const text = doc.getText();
      for (const h of core.hotFunctions(state.profile, relPath(doc), cfg().get('hotThresholdPct') ?? 5)) {
        const line = core.locateFunction(h, text);
        if (!line) continue;
        out.push(new vscode.CodeLens(new vscode.Range(line - 1, 0, line - 1, 0), {
          title: `$(flame) ${h.pct.toFixed(1)}% of CPU`, command: 'watchtower.refresh',
        }));
      }
      return out;
    },
  };

  const open = (kind) => async (id) => {
    const x = await client();
    if (!x) return vscode.window.showWarningMessage('Sign in to Watchtower first.');
    return vscode.env.openExternal(vscode.Uri.parse(linkBase(x)[kind](id)));
  };

  context.subscriptions.push(
    diagnostics, changed, status,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
    vscode.commands.registerCommand('watchtower.signIn', async () => {
      const token = await vscode.window.showInputBox({
        title: 'Watchtower API token', prompt: 'Read-only API token', password: true, ignoreFocusOut: true,
      });
      if (!token) return;
      await context.secrets.store(SECRET, token);
      await refresh();
    }),
    vscode.commands.registerCommand('watchtower.signOut', async () => {
      await context.secrets.delete(SECRET);
      state = { issues: new Map(), hot: [] };
      diagnostics.clear();
      changed.fire();
      status.text = '$(eye) Watchtower: sign in';
    }),
    vscode.commands.registerCommand('watchtower.refresh', refresh),
    vscode.commands.registerCommand('watchtower.openIssue', open('issue')),
    vscode.commands.registerCommand('watchtower.openTrace', open('trace')),
    vscode.commands.registerCommand('watchtower.openReplay', open('replay')),
    vscode.workspace.onDidOpenTextDocument(publishDiagnostics),
  );
  refresh();

  // Exposed for the extension-host tests; the token is never returned.
  return {
    setToken: (t) => context.secrets.store(SECRET, t),
    refresh,
    diagnostics,
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
