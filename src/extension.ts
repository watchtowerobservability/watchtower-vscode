import * as vscode from 'vscode';
import * as core from './core';

const SECRET = 'watchtower.apiToken';
const cfg = () => vscode.workspace.getConfiguration('watchtower');

/** Per-file state: the latest event of each unresolved issue, and the service's profile rows. */
type State = { entries: core.Entry[]; profile?: core.ProfileRow[] | undefined };
let state: State = { entries: [] };

type Conn = { api: core.Client; apiUrl: string; projectId: string; c: vscode.WorkspaceConfiguration };

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('watchtower');
  const changed = new vscode.EventEmitter<void>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = 'watchtower.refresh';

  const client = async (): Promise<Conn | undefined> => {
    const token = await context.secrets.get(SECRET);
    const c = cfg();
    const apiUrl = c.get<string>('apiUrl');
    const projectId = c.get<string>('projectId');
    if (!token || !apiUrl || !projectId) return undefined;
    return { api: core.createClient({ apiUrl, projectId, token }), apiUrl, projectId, c };
  };
  const linkBase = (x: Conn) => core.links(x.c.get<string>('webUrl') || x.apiUrl, x.projectId);

  async function refresh(): Promise<void> {
    const x = await client();
    if (!x) {
      status.text = '$(eye) Watchtower: sign in';
      status.show();
      return;
    }
    try {
      status.text = '$(sync~spin) Watchtower';
      status.show();
      const list = (await x.api.issues(x.c.get<number>('maxIssues') || 30)).data ?? [];
      const entries = await Promise.all(list.map(async (issue) => ({
        issue, event: await x.api.latestEvent(issue.id).catch(() => undefined),
      })));
      state = { entries };
      const service = x.c.get<string>('service');
      if (service) state.profile = (await x.api.profileTable(service).catch(() => ({ data: [] }))).data;
      status.text = `$(eye) Watchtower: ${list.length} issues`;
    } catch (e) {
      status.text = '$(warning) Watchtower';
      void vscode.window.showWarningMessage(e instanceof Error ? e.message : String(e));
    }
    logCache.clear();
    changed.fire();
    void loadLogs();
    publishDiagnostics();
  }

  const relPath = (doc: vscode.TextDocument) => vscode.workspace.asRelativePath(doc.uri, false);
  const issuesIn = (doc: vscode.TextDocument) => core.issuesForFile(state.entries, relPath(doc));

  function publishDiagnostics(): void {
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

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(doc) {
      const out: vscode.CodeLens[] = [];
      for (const { issue, frame, traceId, replayId } of issuesIn(doc)) {
        const range = new vscode.Range(Math.max(frame.line - 1, 0), 0, Math.max(frame.line - 1, 0), 0);
        out.push(new vscode.CodeLens(range, {
          title: `$(bug) ${issue.title ?? issue.id}`, command: 'watchtower.openIssue', arguments: [issue.id],
        }));
        if (traceId) out.push(new vscode.CodeLens(range, { title: 'Trace', command: 'watchtower.openTrace', arguments: [traceId] }));
        if (replayId) out.push(new vscode.CodeLens(range, { title: 'Replay', command: 'watchtower.openReplay', arguments: [replayId] }));
      }
      const text = doc.getText();
      for (const h of core.hotFunctions(state.profile, relPath(doc), cfg().get<number>('hotThresholdPct') ?? 5)) {
        const line = core.locateFunction(h, text);
        if (!line) continue;
        out.push(new vscode.CodeLens(new vscode.Range(line - 1, 0, line - 1, 0), {
          title: `$(flame) ${h.pct.toFixed(1)}% of CPU`, command: 'watchtower.refresh',
        }));
      }
      return out;
    },
  };

  // Logs at a logger call: looked up per line (cached 60 s) so lenses and hovers share one request.
  const logCache = new Map<string, { at: number; hits: core.LogHits }>();
  async function logsAt(doc: vscode.TextDocument, line: number): Promise<core.LogHits | undefined> {
    const service = cfg().get<string>('service');
    const x = await client();
    if (!x || !service) return undefined;
    const file = relPath(doc);
    const key = `${file}:${line}`;
    const hit = logCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.hits;
    // by code location first, then (template fallback) by the call's literal text
    let hits = await x.api.logs(service, { file, line: line + 1 }).catch(() => undefined);
    const lit = core.literalOf(doc.lineAt(line).text);
    if (hits && !hits.data?.length && lit) hits = await x.api.logs(service, undefined, 100, lit).catch(() => undefined);
    if (hits) logCache.set(key, { at: Date.now(), hits });
    return hits;
  }

  const logLenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    async provideCodeLenses(doc) {
      const out: vscode.CodeLens[] = [];
      for (const line of core.logSites(doc.getText())) {
        const hits = await logsAt(doc, line);
        if (!hits?.data?.length) continue;
        out.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: `$(output) ${core.logsTitle(hits)}`, command: 'watchtower.openLogs', arguments: [relPath(doc), line + 1, core.literalOf(doc.lineAt(line).text)],
        }));
      }
      return out;
    },
  };

  const logHover: vscode.HoverProvider = {
    async provideHover(doc, pos) {
      if (!core.logSites(doc.lineAt(pos.line).text, 1).length) return undefined;
      const hits = await logsAt(doc, pos.line);
      if (!hits?.data?.length) return undefined;
      const md = new vscode.MarkdownString(`**${core.logsTitle(hits)}** at this line`);
      for (const r of hits.data.slice(0, 5)) md.appendMarkdown(`\n\n\`${`${r.severity_text ?? ''} ${r.body ?? ''}`.trim().slice(0, 160).replace(/`/g, "'")}\``);
      return new vscode.Hover(md);
    },
  };

  // Logs view: the service's latest lines (Explorer sidebar).
  const logRows: core.LogRow[] = [];
  const logTree = new vscode.EventEmitter<void>();
  async function loadLogs(): Promise<void> {
    const x = await client();
    const service = cfg().get<string>('service');
    logRows.length = 0;
    if (x && service) logRows.push(...((await x.api.logs(service, undefined, 50).catch(() => ({}) as core.LogHits)).data ?? []));
    logTree.fire();
  }
  const logsView: vscode.TreeDataProvider<core.LogRow> = {
    onDidChangeTreeData: logTree.event,
    getChildren: () => logRows,
    getTreeItem: (r) => {
      const i = new vscode.TreeItem(`${r.severity_text ?? ''} ${r.body ?? ''}`.trim().slice(0, 200));
      i.description = r.ts_ns ? new Date(r.ts_ns / 1e6).toLocaleTimeString() : '';
      i.command = { title: 'Open Logs', command: 'watchtower.openLogs' };
      return i;
    },
  };

  const open = (kind: 'issue' | 'trace' | 'replay') => async (id: string) => {
    const x = await client();
    if (!x) return vscode.window.showWarningMessage('Sign in to Watchtower first.');
    return vscode.env.openExternal(vscode.Uri.parse(linkBase(x)[kind](id)));
  };

  context.subscriptions.push(
    diagnostics, changed, status,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, logLenses),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, logHover),
    vscode.window.registerTreeDataProvider('watchtower.logs', logsView),
    logTree,
    vscode.commands.registerCommand('watchtower.openLogs', async (file?: string, line?: number, text?: string) => {
      const x = await client();
      const service = cfg().get<string>('service');
      if (!x || !service) return vscode.window.showWarningMessage('Sign in and set watchtower.service first.');
      return vscode.env.openExternal(vscode.Uri.parse(linkBase(x).logs(service, file && line ? { file, line } : undefined, text || undefined)));
    }),
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
      state = { entries: [] };
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
  void refresh();

  // Exposed for the extension-host tests; the token is never returned.
  return {
    setToken: (t: string) => context.secrets.store(SECRET, t),
    refresh,
    diagnostics,
  };
}

export function deactivate(): void {}
