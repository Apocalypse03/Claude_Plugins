// Pure helpers: parsing CLI output and scoring. No `$` here, so tests can call them directly.

/** Plugin ids that are safe to hand to a command line, `cmd /c` included. */
export const SAFE_ID = /^[A-Za-z0-9._@:+-]{1,200}$/

/** Scopes the CLI's --scope flag accepts. */
export const CLI_SCOPES = ['user', 'project', 'local']

/** Reads "Always-on:   ~1.2k tok" from `claude plugin details`; null when absent. */
export function parseAlwaysOn(text) {
  const m = /Always-on:\s*~?\s*([\d.,]+)\s*([kKmM]?)\s*tok/.exec(text ?? '')
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const mult = m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1
  return Math.round(n * mult)
}

/** Strings out of an `errors` / `notes` field, whatever its shape. */
export function asStrings(v) {
  if (v == null) return []
  const list = Array.isArray(v) ? v : [v]
  return list
    .map(x => (typeof x === 'string' ? x : x && typeof x === 'object' ? (x.message ?? JSON.stringify(x)) : String(x)))
    .filter(s => s.length > 0)
}

/** One `claude plugin list --json` entry, normalised. */
export function fromListEntry(p) {
  return {
    id: String(p.id ?? p.name ?? '?'),
    version: String(p.version ?? '?'),
    scope: String(p.scope ?? '?'),
    enabled: p.enabled !== false,
    mcpServers: p.mcpServers && typeof p.mcpServers === 'object' ? Object.keys(p.mcpServers) : [],
    errors: asStrings(p.errors),
    notes: asStrings(p.notes),
  }
}

/**
 * Turns the signals into points; more points, less useful.
 *   disabled +4, errors +3, notes +1, MCP servers +1 (+2 at five or more),
 *   always-on tokens +1 at 1.5k, +2 at 5k.
 * 0-1 Keep, 2-3 Review, 4+ Consider removing. Managed plugins are never
 * "Consider removing": the person cannot remove them.
 */
export function score(row) {
  let points = 0
  const reasons = []
  if (!row.enabled) { points += 4; reasons.push('installed but disabled') }
  if (row.errors.length) { points += 3; reasons.push(`${row.errors.length} error(s)`) }
  if (row.notes.length) { points += 1; reasons.push(`${row.notes.length} note(s)`) }
  if (row.mcpServers.length >= 5) { points += 2; reasons.push(`${row.mcpServers.length} MCP servers`) }
  else if (row.mcpServers.length) { points += 1; reasons.push(`${row.mcpServers.length} MCP server(s)`) }
  if (row.tokens != null && row.tokens >= 5000) { points += 2; reasons.push(`~${fmtTokens(row.tokens)} always-on tokens`) }
  else if (row.tokens != null && row.tokens >= 1500) { points += 1; reasons.push(`~${fmtTokens(row.tokens)} always-on tokens`) }
  if (row.scope === 'managed') reasons.push('managed scope (cannot be changed here)')
  let usefulness = points >= 4 ? 'Consider removing' : points >= 2 ? 'Review' : 'Keep'
  if (row.scope === 'managed' && usefulness === 'Consider removing') usefulness = 'Review'
  return { score: points, usefulness, reasons }
}

export function fmtTokens(n) {
  if (n == null) return '?'
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

/** `enabledPlugins` entries of one settings file's text, tagged with a scope. */
export function fromSettings(text, scope) {
  let json
  try { json = JSON.parse(text) } catch { return [] }
  const map = json && typeof json.enabledPlugins === 'object' && json.enabledPlugins ? json.enabledPlugins : {}
  return Object.entries(map).map(([id, on]) => ({
    id, version: '?', scope, enabled: on === true, mcpServers: [], errors: [], notes: [],
  }))
}

/** The `.claude` folder above a path that contains one (`~/.claude/dev-mods/...`). */
export function claudeDirOf(path) {
  const p = String(path ?? '').replace(/\\/g, '/')
  const i = p.lastIndexOf('/.claude/')
  return i >= 0 ? p.slice(0, i + '/.claude'.length) : null
}
