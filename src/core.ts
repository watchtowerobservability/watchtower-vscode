// Pure helpers (no vscode import) so they are unit-testable without the extension host.

export const mask = (k: string | undefined): string => (k ? `${String(k).slice(0, 4)}…(masked)` : '');

type Json = Record<string, unknown>;
type FetchLike = (url: string, init: { headers: Record<string, string>; method?: string; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Issue = { id: string; title?: string; times_seen?: number };
export type RawFrame = { filename?: string; abs_path?: string; file?: string; lineno?: number; line?: number; function?: string; func?: string };
export type IssueEvent = {
  trace_id?: string; replay_id?: string;
  contexts?: { trace?: { trace_id?: string }; replay?: { replay_id?: string } };
  exception?: { values?: { stacktrace?: { frames?: RawFrame[] } }[] };
  stacktrace?: { frames?: RawFrame[] };
  frames?: RawFrame[];
};
export type Frame = { file: string; line: number; fn: string };
export type ProfileRow = { name?: string; function?: string; file?: string; filename?: string; line?: number; lineno?: number; self?: number; total?: number };
export type Hot = { name: string; line: number; pct: number };

export type LogRow = { body?: string; severity_text?: string; service?: string; ts_ns?: number };
export type LogHits = { data?: LogRow[]; next_cursor?: string | null };

export interface Client {
  toString(): string;
  issues(limit?: number): Promise<{ data?: Issue[] }>;
  latestEvent(id: string): Promise<IssueEvent | undefined>;
  profileTable(service: string): Promise<{ data?: ProfileRow[] }>;
  /** Last 24h of log records; with file+line only those stamped with that code location. */
  logs(service: string, at?: { file: string; line: number }, limit?: number, text?: string): Promise<LogHits>;
}

/** Minimal API client. The token goes only into the Authorization header; errors never contain it. */
export function createClient({ apiUrl, projectId, token, fetchImpl = globalThis.fetch as unknown as FetchLike }:
  { apiUrl: string; projectId: string; token: string; fetchImpl?: FetchLike }): Client {
  if (!apiUrl || !projectId || !token) throw new Error('apiUrl, projectId and token are required');
  const base = `${apiUrl.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(projectId)}`;
  async function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]): [string, string] => [k, String(v)]));
    const res = await fetchImpl(`${base}${path}${q.size ? `?${q}` : ''}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      let detail = '';
      try { detail = String(((await res.json()) as Json).detail ?? ''); } catch { /* body not problem+json */ }
      throw new Error(`Watchtower API ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  }
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`Watchtower API ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    toString: () => `WatchtowerClient(${base}, token=${mask(token)})`,
    issues: (limit = 50) => get('/issues', { limit, status: 'unresolved' }),
    latestEvent: async (id) => (await get<{ data?: IssueEvent[] }>(`/issues/${encodeURIComponent(id)}/events`, { limit: 1 })).data?.[0],
    profileTable: (service) => get('/profiles/table', { service }),
    logs: (service, at, limit = 100, text) => post('/logs/search', {
      services: [service], limit, from: new Date(Date.now() - 864e5).toISOString(), attrs: at ? codeAttrs(at.file, at.line) : [],
      ...(text ? { text } : {}),
    }),
  };
}

/** Logs match a source line by the code location the SDKs stamp on records (code.filepath may be absolute). */
export const codeAttrs = (file: string, line: number) => [
  { key: 'code.filepath', op: 'contains', value: file }, { key: 'code.lineno', op: 'eq', value: String(line) },
];

// shortcut: one regex for common loggers, not a parser; a call split over lines matches on its first line only.
const LOG_CALL = /\b(?:console|log|logger|logging|slog|_log|LOG|LOGGER|_logger)\w*\.(?:trace|debug|info|warn|warning|error|exception|critical|log|Debug|Info|Warn|Error|Printf|Println|Information)\(|\b(?:trace|debug|info|warn|error)!\(/;

/** 0-based lines holding a logger call, at most max. */
export function logSites(text: string, max = 15): number[] {
  const out: number[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) if (LOG_CALL.test(lines[i] ?? '')) out.push(i);
  return out;
}

/** Longest fixed text of the first string literal on a logger line (no %s, {} or ${} placeholders); '' under 6 chars. */
export function literalOf(line: string): string {
  const m = /"((?:[^"\\]|\\.)+)"|'([^']+)'|`([^`]+)`/.exec(line);
  const lit = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  const best = lit.split(/%[-+# 0-9.]*[a-zA-Z]|\$?\{[^}]*\}|\\./).map((p) => p.trim()).sort((a, b) => b.length - a.length)[0] ?? '';
  return best.length >= 6 ? best : '';
}

/** "N log lines/24h" (N+ when the window was full). */
export const logsTitle = (h: LogHits, window = 100): string =>
  `${h.data?.length ?? 0}${h.next_cursor || (h.data?.length ?? 0) >= window ? '+' : ''} log lines/24h`;

/** Stack frames of an event, innermost last in the payload, returned innermost first. */
export function framesOf(ev: IssueEvent | undefined): Frame[] {
  if (!ev) return [];
  const out: RawFrame[] = [];
  for (const v of ev.exception?.values ?? []) out.push(...(v.stacktrace?.frames ?? []));
  out.push(...(ev.stacktrace?.frames ?? []), ...(ev.frames ?? []));
  return out
    .map((f) => ({
      file: f.filename ?? f.abs_path ?? f.file ?? '',
      line: Number(f.lineno ?? f.line ?? 0),
      fn: f.function ?? f.func ?? '',
    }))
    .filter((f) => f.file && f.line > 0)
    .reverse();
}

const norm = (p: string) => String(p).replace(/\\/g, '/').replace(/^[a-z]+:\/\//i, '').replace(/^\/+/, '');

/** True when a frame path (often absolute on another machine, or a URL) names the workspace file. */
export function sameFile(framePath: string, relPath: string): boolean {
  const f = norm(framePath).split('?')[0] ?? '';
  const r = norm(relPath);
  return f === r || f.endsWith(`/${r}`) || r.endsWith(`/${f}`);
}

export const traceIdOf = (ev: IssueEvent | undefined): string | undefined => ev?.trace_id ?? ev?.contexts?.trace?.trace_id;
export const replayIdOf = (ev: IssueEvent | undefined): string | undefined => ev?.replay_id ?? ev?.contexts?.replay?.replay_id;

export type Entry = { issue: Issue; event: IssueEvent | undefined };
export type FileIssue = { issue: Issue; frame: Frame; traceId: string | undefined; replayId: string | undefined };

/** Issues having a frame in relPath: [{issue, frame}], one per issue (innermost matching frame). */
export function issuesForFile(entries: Entry[], relPath: string): FileIssue[] {
  const out: FileIssue[] = [];
  for (const { issue, event } of entries) {
    const frame = framesOf(event).find((f) => sameFile(f.file, relPath));
    if (frame) out.push({ issue, frame, traceId: traceIdOf(event), replayId: replayIdOf(event) });
  }
  return out;
}

/** Profile rows in relPath whose self cost is at least minPct of the profile: [{name, line, pct}]. */
export function hotFunctions(rows: ProfileRow[] | undefined, relPath: string, minPct = 5): Hot[] {
  const list = rows ?? [];
  const total = Math.max(0, ...list.map((r) => Number(r.total ?? 0)));
  if (!total) return [];
  return list
    .filter((r) => sameFile(r.file ?? r.filename ?? '', relPath))
    .map((r) => ({
      name: r.name ?? r.function ?? '',
      line: Number(r.line ?? r.lineno ?? 0),
      pct: (100 * Number(r.self ?? 0)) / total,
    }))
    .filter((r) => r.name && r.pct >= minPct)
    .sort((a, b) => b.pct - a.pct);
}

/** Line (1-based) of a function: the profile line when known, else its first definition in text. */
export function locateFunction(hot: { name: string; line: number }, text: string): number {
  if (hot.line > 0) return hot.line;
  const esc = (hot.name.split(/[.:]/).pop() ?? '').replace(/[^\w$]/g, '');
  if (!esc) return 0;
  const re = new RegExp(`\\b(function\\s+${esc}|def\\s+${esc}|func\\s+(\\([^)]*\\)\\s*)?${esc}|fn\\s+${esc}|${esc}\\s*[=(:])`);
  const i = text.split('\n').findIndex((l) => re.test(l));
  return i < 0 ? 0 : i + 1;
}

/** Web UI links; webUrl defaults to the API origin. */
export function links(webUrl: string, projectId: string) {
  const b = `${webUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}`;
  return {
    issue: (id: string) => `${b}/issues/${encodeURIComponent(id)}`,
    trace: (id: string) => `${b}/traces/${encodeURIComponent(id)}`,
    logs: (service: string, at?: { file: string; line: number }, text?: string) =>
      `${b}/logs?q=${encodeURIComponent(JSON.stringify({
        services: service, severities: [], ...(text ? { text, attrs: [] } : { attrs: at ? codeAttrs(at.file, at.line) : [] }),
      }))}`,
    replay: (id: string) => `${b}/replays/${encodeURIComponent(id)}`,
  };
}
