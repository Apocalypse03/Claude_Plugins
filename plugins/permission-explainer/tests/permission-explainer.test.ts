import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'permission-explainer'
const PANE = 'permission-explainer'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const HAIKU_REPLY = [
  'What: Claude wants to run `npm test` in a shell.',
  'Why: It is a shell command, which can change files.',
  'Options: Always allow npm test commands for this project.',
  'If approved: The tests run now.',
  'If denied: The command is blocked.',
].join('\n')

const NPM_TEST = {
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run tests' },
  permission_suggestions: [
    {
      type: 'addRules' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
      behavior: 'allow' as const,
      destination: 'localSettings' as const,
    },
    { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
  ],
}

function paneProps(columns = 40) {
  return {
    title: 'Permission Explanation',
    isFocused: false,
    bodyColumns: columns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  }
}

async function paneText($: Engine, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PANE,
    props: paneProps(),
    viewport: { columns: 160, rows: 40, isFullscreen: true },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts.join('\n')
}

/** What the engine answers beneath the plugin in a session. */
function engine(on: On) {
  on('classic.PermissionRequest', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
}

/** Lets the unawaited Haiku call and its state write settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0))
}

describe('permission-explainer', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`idle pane shows the placeholder (${surface})`, async ($, on) => {
      engine(on)
      const text = await paneText($, surface)
      expect(text).toContain('Permission Explanation')
      expect(text).toContain('No pending permission request.')
    })

    test(`Haiku's explanation is shown for a pending request (${surface})`, async ($, on) => {
      engine(on)
      on('model.complete', () => ({ value: { isAnswered: true, text: HAIKU_REPLY, usage: USAGE } }))
      await $.classic.PermissionRequest(NPM_TEST)
      await settle()
      const text = await paneText($, surface)
      expect(text).toContain('What: Claude wants to run `npm test` in a shell.')
      expect(text).toContain('If denied: The command is blocked.')
      expect(text).toContain('by Haiku')
    })
  }

  test('falls back to the template when Haiku fails, covering all five parts', async ($, on) => {
      engine(on)
    on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE } }))
    await $.classic.PermissionRequest(NPM_TEST)
    await settle()
    const text = await paneText($, 'terminal')
    expect(text).toContain('What: Run a Bash command: `npm test`')
    expect(text).toContain('Why: Shell commands can change files')
    expect(text).toContain('Always allow Bash(npm test:*) in this project (local); switch to accept-edits mode for this session.')
    expect(text).toContain('If approved: The command runs now.')
    expect(text).toContain('If denied: The command is blocked and Claude is told no.')
    expect(text).toContain('template')
    const words = text.split('\n').filter(l => /^(What|Why|Options|If approved|If denied):/.test(l)).join(' ')
    expect(words.split(/\s+/).filter(Boolean).length <= 60).toBe(true)
  })

  test('an empty suggestions list says so', async ($, on) => {
      engine(on)
    await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt', content: 'x' }, permission_suggestions: [] })
    await settle()
    const text = await paneText($, 'terminal')
    expect(text).toContain('What: Create or overwrite /tmp/a.txt.')
    expect(text).toContain('Options: None offered')
  })

  test('a Haiku reply that is too long or malformed keeps the template', async ($, on) => {
      engine(on)
    on('model.complete', () => ({ value: { isAnswered: true, text: 'Sure! Here is an explanation: ' + 'word '.repeat(80), usage: USAGE } }))
    await $.classic.PermissionRequest(NPM_TEST)
    await settle()
    expect(await paneText($, 'terminal')).toContain('template')
  })

  test('the pane clears once the call is resolved (approved or denied)', async ($, on) => {
      engine(on)
    let midCall = ''
    on('tool.call', async (_, e) => {
      // The engine raises PermissionRequest inside the call, then the person answers.
      await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: e.tool === 'Bash' ? e.command : '' } })
      await settle()
      midCall = await paneText($, 'terminal')
      return { deny: 'The user denied this.' }
    })
    await $.tool.call({ tool: 'Bash', command: 'rm -rf node_modules' })
    expect(midCall).toContain('rm -rf node_modules')
    expect(await paneText($, 'terminal')).toContain('No pending permission request.')
  })

  test('an auto-denied request is cleared by PermissionDenied', async ($, on) => {
      engine(on)
    await $.classic.PermissionRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } })
    await settle()
    expect(await paneText($, 'terminal')).toContain('Fetch https://example.com')
    await $.classic.PermissionDenied({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' }, tool_use_id: 'toolu_x', reason: 'auto mode' })
    expect(await paneText($, 'terminal')).toContain('No pending permission request.')
  })

  test('draws only in its own Pane, never in AbovePrompt or another pane', async ($, on) => {
      engine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, null, 'engine')
    })
    await $.classic.PermissionRequest(NPM_TEST)
    await settle()
    const other = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'someone-else', props: paneProps() })
    expect(await other.find({ text: /Permission Explanation/ })).toBeUndefined()
    expect((await other.find({ type: 'Text' }))?.text).toBe('engine')
    await other.unmount()

    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
    })
    expect(await band.find({ text: /Permission Explanation|What:/ })).toBeUndefined()
    expect((await band.find({ type: 'Text' }))?.text).toBe('engine')
    await band.unmount()
  })

  test('an approved call clears the pane once it has run', async ($, on) => {
    engine(on)
    on('tool.call', async (_, e) => {
      await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: e.tool === 'Edit' ? e.file_path : '' } })
      await settle()
      expect(await paneText($, 'terminal')).toContain('What: Edit src/app.ts.')
      return { result: 'The file src/app.ts has been updated.' }
    })
    await $.tool.call({ tool: 'Edit', file_path: 'src/app.ts', old_string: 'a', new_string: 'b' })
    expect(await paneText($, 'terminal')).toContain('No pending permission request.')
  })
})
