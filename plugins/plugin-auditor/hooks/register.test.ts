import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseAlwaysOn, score } from './audit.js'

const LIST = [
  { id: 'alpha@m', version: '1.0.0', scope: 'user', enabled: true },
  { id: 'beta@m', version: '2.0.0', scope: 'project', enabled: false, errors: ['boom'] },
  { id: 'gamma@m', version: '0.1.0', scope: 'managed', enabled: true, mcpServers: { a: {}, b: {} } },
]

const DETAILS: Record<string, string> = {
  'alpha@m': 'alpha\nProjected token cost\n  Always-on:   ~120 tok   added to every session\n',
  'beta@m': 'beta\nProjected token cost\n  Always-on:   ~6.2k tok   added to every session\n',
  'gamma@m': 'gamma\nProjected token cost\n  Always-on:   ~0 tok   added to every session\n',
}

const res = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const ok = (stdout: string) => res(0, stdout)

/** A fake `claude` CLI beneath the mod; returns the argv log. */
function fakeCli(on: On, opts: { listFails?: boolean; opened?: string[] } = {}) {
  const calls: string[][] = []
  const list = LIST.map(p => ({ ...p }))
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const args = argv.slice(argv.indexOf('claude') + 1)
    if (args[0] !== 'plugin') return res(1, '', 'unknown')
    if (args[1] === 'list') {
      if (opts.listFails) return res(1, '', 'no such flag')
      return ok(JSON.stringify(list))
    }
    if (args[1] === 'details') return ok(DETAILS[args[2]] ?? 'nothing')
    if (args[1] === 'enable' || args[1] === 'disable') {
      const p = list.find(x => x.id === args[2])
      if (p) p.enabled = args[1] === 'enable'
      return ok('{}')
    }
    if (args[1] === 'uninstall') {
      const i = list.findIndex(x => x.id === args[2])
      if (i >= 0) list.splice(i, 1)
      return ok('{}')
    }
    return ok('')
  })
  // Stand in for the engine's own pane drawing and pane opening.
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, `engine draws ${e.requestId}`)
  })
  on('ui.open', async (_$, e) => { opts.opened?.push(e.id); return { value: { isPlaced: true as const } } })
  return calls
}

const PANE_PROPS = { title: 'Plugin audit', isFocused: false, bodyColumns: 140, placement: 'dock' } as never

describe('helpers', () => {
  test('parses always-on tokens', async () => {
    expect(parseAlwaysOn('  Always-on:   ~495 tok   added')).toBe(495)
    expect(parseAlwaysOn('  Always-on:   ~1.3k tok')).toBe(1300)
    expect(parseAlwaysOn('nothing here')).toBe(null)
  })

  test('scores signals into labels', async () => {
    const base = { id: 'x', version: '1', scope: 'user', enabled: true, tokens: 10, mcpServers: [], errors: [], notes: [] }
    expect(score(base).usefulness).toBe('Keep')
    expect(score({ ...base, notes: ['n'], mcpServers: ['a'] }).usefulness).toBe('Review')
    expect(score({ ...base, enabled: false }).usefulness).toBe('Consider removing')
    expect(score({ ...base, enabled: false, scope: 'managed' }).usefulness).toBe('Review')
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  describe(surface, () => {
    test('/plugin-audit opens the pane and fills the table', async ($, on) => {
      const opened: string[] = []
      const calls = fakeCli(on, { opened })

      const ran = await $.command.run({ command: 'plugin-audit', args: '' } as never)
      expect(ran.text).toContain('pane opened')
      expect(opened).toEqual(['plugin-auditor'])

      const ui = await $.ui.mount({ plugin: 'plugin-auditor', surface, component: 'Pane', props: PANE_PROPS, requestId: 'plugin-auditor', viewport: { columns: 140, rows: 40 } as never })
      // Wait for the audit started by the command to finish.
      for (let i = 0; i < 50 && !(await ui.find({ type: 'Button', key: 'refresh', text: 'Refresh' })); i++) await $.clock.sleep(10)

      expect((await ui.find({ text: 'alpha@m' }))).toBeDefined()
      expect((await ui.find({ text: '~6.2k' }))).toBeDefined()
      expect((await ui.find({ text: 'Consider removing' }))).toBeDefined()
      expect(await ui.find({ key: 'toggle:gamma@m' })).toBeUndefined() // managed: no toggle
      expect(calls.some(a => a.includes('details'))).toBe(true)
    })

    test('enable/disable toggles state, refresh re-runs, remove confirms', async ($, on) => {
      const calls = fakeCli(on)
      const ui = await $.ui.mount({ plugin: 'plugin-auditor', surface, component: 'Pane', props: PANE_PROPS, requestId: 'plugin-auditor', viewport: { columns: 140, rows: 40 } as never })
      await ui.press({ key: 'refresh' })
      expect((await ui.find({ key: 'toggle:alpha@m' }))?.text).toBe('Disable')

      await ui.press({ key: 'toggle:alpha@m' })
      expect((await ui.find({ key: 'toggle:alpha@m' }))?.text).toBe('Enable')
      expect(calls.some(a => a.includes('disable') && a.includes('alpha@m') && a.includes('user'))).toBe(true)

      await ui.press({ key: 'toggle:beta@m' })
      expect((await ui.find({ key: 'toggle:beta@m' }))?.text).toBe('Disable')

      const listsBefore = calls.filter(a => a.includes('list')).length
      await ui.press({ key: 'refresh' })
      expect(calls.filter(a => a.includes('list')).length).toBe(listsBefore + 1)

      await ui.press({ key: 'details:alpha@m' })
      expect(await ui.find({ text: /Always-on:\s+~120 tok/ })).toBeDefined()
      await ui.press({ key: 'close-details' })

      await ui.press({ key: 'remove:alpha@m' })
      expect(calls.some(a => a.includes('uninstall'))).toBe(false)
      await ui.press({ key: 'confirm-remove' })
      expect(calls.some(a => a.includes('uninstall') && a.includes('alpha@m'))).toBe(true)
      expect(await ui.find({ key: 'toggle:alpha@m' })).toBeUndefined()
    })

    test('shows "Audit failed" when nothing can be listed', async ($, on) => {
      fakeCli(on, { listFails: true })
      on('fs.read', async () => ({ deny: 'missing' }))
      const ui = await $.ui.mount({ plugin: 'plugin-auditor', surface, component: 'Pane', props: PANE_PROPS, requestId: 'plugin-auditor' })
      await ui.press({ key: 'refresh' })
      expect(await ui.find({ text: 'Audit failed' })).toBeDefined()
    })

    test('leaves other panes alone', async ($, on) => {
      fakeCli(on)
      const ui = await $.ui.mount({ plugin: 'plugin-auditor', surface, component: 'Pane', props: PANE_PROPS, requestId: 'someone-else' })
      expect(await ui.find({ key: 'refresh' })).toBeUndefined()
      expect(await ui.find({ text: 'engine draws someone-else' })).toBeDefined()
    })
  })
}
