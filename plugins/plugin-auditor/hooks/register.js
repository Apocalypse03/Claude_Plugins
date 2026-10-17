// plugin-auditor: /plugin-audit opens a pane that audits installed plugins and mods.
// Draws only in its own Pane (requestId PANE); every other render request is passed on.

import {
  SAFE_ID, CLI_SCOPES, parseAlwaysOn, fromListEntry, score, fmtTokens, fromSettings, claudeDirOf,
} from './audit.js'

const PANE = 'plugin-auditor'
const TITLE = 'Plugin audit'
const STORE_KEY = 'audit'
const DETAILS_CONCURRENCY = 4

const AUDIT = { plugin: 'plugin-auditor', key: 'audit' }
const VIEW = { plugin: 'plugin-auditor', key: 'view' }
const PROGRESS = { plugin: 'plugin-auditor', key: 'progress' }
const MESSAGE = { plugin: 'plugin-auditor', key: 'message' }

const NO_VIEW = { kind: 'none' }
const IDLE = { isRunning: false, done: 0, total: 0 }

// ---- running the CLI ------------------------------------------------------

// On Windows `claude` is often a .cmd shim that cannot start without a shell;
// remember whichever form started so later calls go straight to it.
let launcher = null

async function claude($, args, timeoutMs = 60000) {
  const forms = launcher ? [launcher] : [['claude'], ['cmd', '/d', '/s', '/c', 'claude']]
  let lastError
  for (const form of forms) {
    try {
      const out = await $.process.run([...form, ...args], { timeoutMs })
      launcher = form
      return out
    } catch (err) {
      lastError = err
    }
  }
  throw lastError ?? new Error('could not start claude')
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

async function listInstalled($) {
  const out = await claude($, ['plugin', 'list', '--json'])
  if (out.exitCode !== 0) throw new Error(`claude plugin list exited ${out.exitCode}: ${out.stderr.trim().slice(0, 300)}`)
  const start = out.stdout.indexOf('[')
  const parsed = JSON.parse(start >= 0 ? out.stdout.slice(start) : out.stdout)
  if (!Array.isArray(parsed)) throw new Error('claude plugin list --json did not return an array')
  return parsed.map(fromListEntry)
}

/** Fallback: `enabledPlugins` in the user's and the project's settings files. */
async function listFromSettings($) {
  const files = []
  const home = claudeDirOf($.plugin.root)
  if (home) files.push([`${home}/settings.json`, 'user'])
  files.push(['.claude/settings.json', 'project'], ['.claude/settings.local.json', 'local'])
  const seen = new Map()
  for (const [path, scope] of files) {
    let text
    try { text = await $.fs.read(path) } catch { continue }
    for (const entry of fromSettings(text, scope)) seen.set(entry.id, entry) // narrower scope wins
  }
  return [...seen.values()]
}

async function details($, id) {
  if (!SAFE_ID.test(id)) return { text: `Skipped: unusual plugin id ${JSON.stringify(id)}`, tokens: null }
  const name = id.split('@')[0]
  try {
    let out = await claude($, ['plugin', 'details', id])
    if (out.exitCode !== 0) out = await claude($, ['plugin', 'details', name])
    const text = (out.stdout + (out.exitCode !== 0 ? `\n${out.stderr}` : '')).trim()
    return { text, tokens: parseAlwaysOn(out.stdout) }
  } catch (err) {
    return { text: `claude plugin details failed: ${errText(err)}`, tokens: null }
  }
}

// ---- the audit --------------------------------------------------------------

async function saveAudit($, audit) {
  await $.state.set(AUDIT, audit)
  try { await $.store.set(STORE_KEY, audit) } catch { /* the session copy still stands */ }
}

async function runAudit($) {
  const { value: progress } = await $.state.get(PROGRESS)
  if (progress?.isRunning) return
  await $.state.set(PROGRESS, { isRunning: true, done: 0, total: 0 })
  await $.state.set(MESSAGE, '')
  try {
    let source = 'cli'
    let entries
    try {
      entries = await listInstalled($)
    } catch (listErr) {
      source = 'settings'
      entries = await listFromSettings($)
      if (entries.length === 0) throw new Error(`claude plugin list --json failed (${errText(listErr)}) and no enabledPlugins were found in settings`)
    }
    await $.state.set(PROGRESS, { isRunning: true, done: 0, total: entries.length })

    const rows = new Array(entries.length)
    let next = 0
    let done = 0
    const worker = async () => {
      while (next < entries.length) {
        const i = next++
        const entry = entries[i]
        const d = await details($, entry.id)
        const row = { ...entry, tokens: d.tokens, details: d.text }
        rows[i] = { ...row, ...score(row) }
        done++
        await $.state.set(PROGRESS, { isRunning: true, done, total: entries.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(DETAILS_CONCURRENCY, entries.length) }, worker))

    rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    await saveAudit($, { at: new Date().toISOString(), source, rows })
  } catch (err) {
    await saveAudit($, { at: new Date().toISOString(), source: 'cli', rows: [], error: errText(err) })
  } finally {
    await $.state.set(PROGRESS, IDLE)
  }
}

// ---- actions ----------------------------------------------------------------

function scopeArgs(scope) {
  return CLI_SCOPES.includes(scope) ? ['--scope', scope] : []
}

async function patchRow($, id, fn) {
  const { value: audit } = await $.state.get(AUDIT)
  if (!audit) return
  const rows = audit.rows.flatMap(r => {
    if (r.id !== id) return [r]
    const changed = fn(r)
    return changed ? [{ ...changed, ...score(changed) }] : []
  })
  await saveAudit($, { ...audit, rows })
}

async function toggle($, row) {
  if (!SAFE_ID.test(row.id)) return $.state.set(MESSAGE, `Refused: unusual plugin id ${row.id}`)
  const verb = row.enabled ? 'disable' : 'enable'
  await $.state.set(MESSAGE, `${verb === 'enable' ? 'Enabling' : 'Disabling'} ${row.id}…`)
  try {
    const out = await claude($, ['plugin', verb, row.id, ...scopeArgs(row.scope), '--json'])
    if (out.exitCode !== 0) {
      return $.state.set(MESSAGE, `${verb} ${row.id} failed: ${(out.stderr || out.stdout).trim().slice(0, 300)}`)
    }
    // Read the state back rather than assuming the flip landed.
    let enabled = !row.enabled
    try {
      const now = (await listInstalled($)).find(p => p.id === row.id)
      if (now) enabled = now.enabled
    } catch { /* keep the assumed flip */ }
    await patchRow($, row.id, r => ({ ...r, enabled }))
    await $.state.set(MESSAGE, `${row.id} is now ${enabled ? 'enabled' : 'disabled'} (takes effect next session).`)
  } catch (err) {
    await $.state.set(MESSAGE, `${verb} ${row.id} failed: ${errText(err)}`)
  }
}

async function remove($, row) {
  await $.state.set(VIEW, NO_VIEW)
  if (!SAFE_ID.test(row.id)) return $.state.set(MESSAGE, `Refused: unusual plugin id ${row.id}`)
  await $.state.set(MESSAGE, `Uninstalling ${row.id}…`)
  try {
    const out = await claude($, ['plugin', 'uninstall', row.id, ...scopeArgs(row.scope), '--json'])
    if (out.exitCode !== 0) {
      return $.state.set(MESSAGE, `Uninstall of ${row.id} failed: ${(out.stderr || out.stdout).trim().slice(0, 300)}`)
    }
    await patchRow($, row.id, () => null)
    await $.state.set(MESSAGE, `Uninstalled ${row.id}.`)
  } catch (err) {
    await $.state.set(MESSAGE, `Uninstall of ${row.id} failed: ${errText(err)}`)
  }
}

// ---- drawing ----------------------------------------------------------------

const LABEL_COLOR = { Keep: 'success', Review: 'warning', 'Consider removing': 'error' }

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return iso
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function drawRowActions(ui, $, row) {
  const { Box, Button } = ui
  const isManaged = row.scope === 'managed'
  return h(Box, { flexDirection: 'row', gap: 1 },
    !isManaged && h(Button, { key: `toggle:${row.id}`, onPress: () => toggle($, row) }, row.enabled ? 'Disable' : 'Enable'),
    h(Button, { key: `details:${row.id}`, onPress: () => $.state.set(VIEW, { kind: 'details', id: row.id }) }, 'Details'),
    !isManaged && h(Button, { key: `remove:${row.id}`, onPress: () => $.state.set(VIEW, { kind: 'confirm-remove', id: row.id }) }, 'Remove'),
  )
}

const COLS = [['Plugin ID', 32], ['Version', 10], ['Scope', 8], ['Enabled', 8], ['Always-on', 10], ['Usefulness', 18]]

function drawWide(ui, $, rows) {
  const { Box, Text } = ui
  const cell = (w, child) => h(Box, { width: w, flexShrink: 0 }, child)
  return h(Box, { flexDirection: 'column' },
    h(Box, { flexDirection: 'row' },
      ...COLS.map(([name, w]) => cell(w, h(Text, { bold: true }, name))),
      h(Text, { bold: true }, 'Actions')),
    ...rows.map(r => h(Box, { key: `row:${r.id}`, flexDirection: 'row' },
      cell(32, h(Text, { wrap: 'truncate-end' }, r.id)),
      cell(10, h(Text, { wrap: 'truncate-end', dimColor: true }, r.version)),
      cell(8, h(Text, null, r.scope)),
      cell(8, h(Text, { color: r.enabled ? 'success' : 'error' }, r.enabled ? 'yes' : 'no')),
      cell(10, h(Text, null, r.tokens == null ? '?' : `~${fmtTokens(r.tokens)}`)),
      cell(18, h(Text, { color: LABEL_COLOR[r.usefulness] }, r.usefulness)),
      drawRowActions(ui, $, r))),
  )
}

function drawNarrow(ui, $, rows) {
  const { Box, Text } = ui
  return h(Box, { flexDirection: 'column' },
    ...rows.map(r => h(Box, { key: `row:${r.id}`, flexDirection: 'column', marginBottom: 1 },
      h(Text, { wrap: 'truncate-end' },
        h(Text, { bold: true }, r.id), ' ',
        h(Text, { color: LABEL_COLOR[r.usefulness] }, r.usefulness)),
      h(Text, { dimColor: true, wrap: 'truncate-end' },
        `v${r.version} · ${r.scope} · ${r.enabled ? 'enabled' : 'disabled'} · ~${fmtTokens(r.tokens)} tok always-on`),
      drawRowActions(ui, $, r))),
  )
}

function drawView(ui, $, view, rows) {
  const { Box, Text, Button } = ui
  const row = view && view.kind !== 'none' ? rows.find(r => r.id === view.id) : undefined
  if (!row) return null
  if (view.kind === 'confirm-remove') {
    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'error', paddingX: 1 },
      h(Text, { color: 'error' }, `Uninstall ${row.id} (${row.scope} scope)? This cannot be undone here.`),
      h(Box, { flexDirection: 'row', gap: 1 },
        h(Button, { key: 'confirm-remove', variant: 'primary', onPress: () => remove($, row) }, 'Yes, uninstall'),
        h(Button, { key: 'cancel-remove', onPress: () => $.state.set(VIEW, NO_VIEW) }, 'Cancel')))
  }
  return h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    h(Box, { flexDirection: 'row', gap: 1 },
      h(Text, { bold: true }, `Details: ${row.id}`),
      h(Button, { key: 'close-details', role: 'dismiss', onPress: () => $.state.set(VIEW, NO_VIEW) }, 'Close')),
    h(Text, { dimColor: true }, `Why "${row.usefulness}": ${row.reasons.length ? row.reasons.join('; ') : 'no concerns'}`),
    row.mcpServers.length > 0 && h(Text, { dimColor: true }, `MCP servers: ${row.mcpServers.join(', ')}`),
    ...row.errors.map(t => h(Text, { color: 'error' }, `error: ${t}`)),
    ...row.notes.map(t => h(Text, { color: 'warning' }, `note: ${t}`)),
    h(Text, null, row.details || '(no output)'))
}

async function drawPane($, e) {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const [{ value: audit }, { value: view }, { value: progress }, { value: message }] = await Promise.all([
    $.state.get(AUDIT), $.state.get(VIEW), $.state.get(PROGRESS), $.state.get(MESSAGE),
  ])
  const isRunning = progress?.isRunning === true
  const columns = e.viewport?.columns ?? 80

  const header = h(Box, { flexDirection: 'row', gap: 1 },
    h(Button, { key: 'refresh', variant: 'primary', onPress: () => runAudit($) }, isRunning ? 'Auditing…' : 'Refresh'),
    h(Text, { dimColor: true, wrap: 'truncate-end' },
      isRunning
        ? `Auditing ${progress.done}/${progress.total || '?'} plugins…`
        : audit
          ? `Last audit ${ago(audit.at)}${audit.source === 'settings' ? ' (from settings files: CLI unavailable)' : ''}`
          : 'No audit yet.'))

  let body
  if (audit?.error) {
    body = h(Box, { flexDirection: 'column' },
      h(Text, { color: 'error', bold: true }, 'Audit failed'),
      h(Text, { color: 'error' }, audit.error))
  } else if (audit && audit.rows.length === 0) {
    body = h(Text, { dimColor: true }, 'No plugins installed.')
  } else if (audit) {
    const counts = { Keep: 0, Review: 0, 'Consider removing': 0 }
    let total = 0
    for (const r of audit.rows) { counts[r.usefulness]++; if (r.enabled && r.tokens) total += r.tokens }
    body = h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true },
        `${audit.rows.length} plugins · ${counts.Keep} keep · ${counts.Review} review · ${counts['Consider removing']} consider removing · ~${fmtTokens(total)} always-on tokens enabled`),
      columns >= 110 ? drawWide(ui, $, audit.rows) : drawNarrow(ui, $, audit.rows),
      drawView(ui, $, view, audit.rows))
  } else {
    body = h(Text, { dimColor: true }, isRunning ? 'Gathering plugins…' : 'Press Refresh to run the audit.')
  }

  return h(Box, { flexDirection: 'column' },
    header,
    message ? h(Text, { color: 'suggestion', wrap: 'wrap' }, message) : null,
    body)
}

// ---- hooks ------------------------------------------------------------------

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plugin-audit',
      description: 'Audit installed plugins and mods: token cost, state, usefulness, with enable/disable/remove',
    })
    // Bring back the last audit from earlier sessions.
    const { value } = await $.state.get(AUDIT)
    if (!value) {
      try {
        const saved = await $.store.get(STORE_KEY)
        if (saved && typeof saved === 'object' && Array.isArray(saved.rows)) await $.state.set(AUDIT, saved)
      } catch { /* nothing saved */ }
    }
    // A reload mid-audit leaves the flag set with no worker behind it.
    await $.state.set(PROGRESS, IDLE)
    return next(e)
  })

  on('command.run', { command: 'plugin-audit' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const { value: audit } = await $.state.get(AUDIT)
    if (!audit) {
      void runAudit($)
      return { text: 'Plugin audit pane opened; running the audit.' }
    }
    return { text: 'Plugin audit pane opened with the cached audit. Press Refresh to re-run it.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    try {
      return await drawPane($, e)
    } catch (err) {
      const { Box, Text } = $.ui.resolve(e)
      return h(Box, { flexDirection: 'column' },
        h(Text, { color: 'error', bold: true }, 'Audit failed'),
        h(Text, { color: 'error' }, errText(err)))
    }
  })
}
