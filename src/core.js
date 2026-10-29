'use strict';
// Pure helpers (no vscode import) so they are unit-testable with plain node.

const mask = (k) => (k ? `${String(k).slice(0, 4)}…(masked)` : '');

/** Minimal API client. The token goes only into the Authorization header; errors never contain it. */
function createClient({ apiUrl, projectId, token, fetchImpl = globalThis.fetch }) {
  if (!apiUrl || !projectId || !token) throw new Error('apiUrl, projectId and token are required');
  const base = `${apiUrl.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(projectId)}`;
  async function get(path, query = {}) {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ''));
    const res = await fetchImpl(`${base}${path}${q.size ? `?${q}` : ''}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail ?? ''; } catch { /* body not problem+json */ }
      throw new Error(`Watchtower API ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }
  return {
    toString: () => `WatchtowerClient(${base}, token=${mask(token)})`,
    issues: (limit = 50) => get('/issues', { limit, status: 'unresolved' }),
    latestEvent: async (id) => (await get(`/issues/${encodeURIComponent(id)}/events`, { limit: 1 })).data?.[0],
    profileTable: (service) => get('/profiles/table', { service }),
  };
}

/** Stack frames of an event, innermost last in the payload, returned innermost first. */
function framesOf(ev) {
  if (!ev) return [];
  const out = [];
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

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^[a-z]+:\/\//i, '').replace(/^\/+/, '');

/** True when a frame path (often absolute on another machine, or a URL) names the workspace file. */
function sameFile(framePath, relPath) {
  const f = norm(framePath).split('?')[0];
  const r = norm(relPath);
  return f === r || f.endsWith(`/${r}`) || r.endsWith(`/${f}`);
}

/** Issues having a frame in relPath: [{issue, frame}], one per issue (innermost matching frame). */
function issuesForFile(entries, relPath) {
  const out = [];
  for (const { issue, event } of entries) {
    const frame = framesOf(event).find((f) => sameFile(f.file, relPath));
    if (frame) out.push({ issue, frame, traceId: traceIdOf(event), replayId: replayIdOf(event) });
  }
  return out;
}

const traceIdOf = (ev) => ev?.trace_id ?? ev?.contexts?.trace?.trace_id;
const replayIdOf = (ev) => ev?.replay_id ?? ev?.contexts?.replay?.replay_id;

/** Profile rows in relPath whose self cost is at least minPct of the profile: [{name, line, pct}]. */
function hotFunctions(rows, relPath, minPct = 5) {
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
function locateFunction(hot, text) {
  if (hot.line > 0) return hot.line;
  const esc = hot.name.split(/[.:]/).pop().replace(/[^\w$]/g, '');
  if (!esc) return 0;
  const re = new RegExp(`\\b(function\\s+${esc}|def\\s+${esc}|func\\s+(\\([^)]*\\)\\s*)?${esc}|fn\\s+${esc}|${esc}\\s*[=(:])`);
  const i = text.split('\n').findIndex((l) => re.test(l));
  return i < 0 ? 0 : i + 1;
}

/** Web UI links; webUrl defaults to the API origin. */
function links(webUrl, projectId) {
  const b = `${webUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}`;
  return {
    issue: (id) => `${b}/issues/${encodeURIComponent(id)}`,
    trace: (id) => `${b}/traces/${encodeURIComponent(id)}`,
    replay: (id) => `${b}/replays/${encodeURIComponent(id)}`,
  };
}

module.exports = { createClient, framesOf, sameFile, issuesForFile, hotFunctions, locateFunction, links, mask };
