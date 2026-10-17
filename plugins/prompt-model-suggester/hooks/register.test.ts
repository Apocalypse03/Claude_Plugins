import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const PLUGIN = 'prompt-model-suggester'
const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
}

type Bottom = { classifierModels: string[]; submitted: { text: string; origin: string }[]; models: string[]; fills: string[] }

// The engine beneath the plugin: a classifier, the prompt queue, the model loop, another mod's band.
function engine(on: On, classify: () => string | null): Bottom {
  const bottom: Bottom = { classifierModels: [], submitted: [], models: [], fills: [] }
  // The engine's classifier: answer a label, or fail like an overloaded API.
  on('model.classify', ($, e) => {
    bottom.classifierModels.push(e.options?.model ?? 'default')
    const label = classify()
    if (label === null) throw new Error('api-error 529')
    return { value: label }
  })
  on('prompt.submit', ($, e) => {
    bottom.submitted.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    bottom.fills.push(e.text)
    return { isFilled: true }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    bottom.models.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <RenderElement>h(Text, {}, 'other mod band')
  })
  return bottom
}

const type = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const runStep = async ($: Engine, turnId: string) => {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-session-default', messageCount: 1 })
  for await (const _ of stream) {
    // drain
  }
}

describe('prompt-model-suggester', () => {
  for (const surface of SURFACES) {
    test(`${surface}: band shows the Haiku classification and cycles haiku → sonnet → opus`, async ($, on) => {
      const bottom = engine(on, () => 'opus')
      const result = await type($, 'Design the sharding architecture for our database')
      expect(result.drop).toContain('opus')
      expect(bottom.classifierModels).toEqual(['haiku'])

      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      expect((await ui.find({ key: 'accept' }))?.text).toBe('Run on opus')

      await ui.press({ key: 'cycle' })
      expect((await ui.find({ key: 'accept' }))?.text).toBe('Run on haiku')
      await ui.press({ key: 'cycle' })
      expect((await ui.find({ key: 'accept' }))?.text).toBe('Run on sonnet')
      await ui.press({ key: 'cycle' })
      expect((await ui.find({ key: 'accept' }))?.text).toBe('Run on opus')
    })

    test(`${surface}: falls back to sonnet when classification fails`, async ($, on) => {
      engine(on, () => null)
      const result = await type($, 'fix the typo in README')
      expect(result.drop).toContain('sonnet')

      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      expect((await ui.find({ key: 'accept' }))?.text).toBe('Run on sonnet')
      expect(await ui.find({ text: /classifier unavailable/ })).toBeDefined()
    })

    test(`${surface}: accepting resubmits the prompt and runs its turn on the chosen model`, async ($, on) => {
      const bottom = engine(on, () => 'haiku')
      await type($, 'rename foo to bar')

      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      await ui.press({ key: 'cycle' }) // haiku → sonnet
      await ui.press({ key: 'accept' })

      expect(bottom.submitted).toEqual([{ text: 'rename foo to bar', origin: 'plugin' }])

      await $.turn.start({ text: 'rename foo to bar', turnId: 't1' })
      await runStep($, 't1')
      expect(bottom.models).toEqual(['sonnet'])

      // A later turn nobody chose a model for keeps the session's model.
      await $.turn.start({ text: 'something else', turnId: 't2' })
      await runStep($, 't2')
      expect(bottom.models).toEqual(['sonnet', 'claude-session-default'])
    })

    test(`${surface}: Edit puts the prompt back in the input`, async ($, on) => {
      const bottom = engine(on, () => 'sonnet')
      await type($, 'explain this regex')
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      await ui.press({ key: 'edit' })
      expect(bottom.fills).toEqual(['explain this regex'])
      expect(bottom.submitted).toEqual([])
    })

    test(`${surface}: leaves the band to other mods when nothing is pending or a survey holds it`, async ($, on) => {
      engine(on, () => 'opus')
      const idle = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      expect(await idle.find({ key: 'accept' })).toBeUndefined()
      expect(await idle.find({ text: 'other mod band' })).toBeDefined()

      await type($, 'refactor the auth module')
      const survey = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
      expect(await survey.find({ key: 'accept' })).toBeUndefined()
      expect(await survey.find({ text: 'other mod band' })).toBeDefined()
    })
  }

  test('does not gate prompts that are not typed at an idle prompt', async ($, on) => {
    const bottom = engine(on, () => 'opus')
    const mid = await $.prompt.submit({ text: 'also do X', wait: false, turnId: 'running', origin: { kind: 'composer' } })
    expect(mid.drop).toBeUndefined()
    const command = await type($, '/compact')
    expect(command.drop).toBeUndefined()
    expect(bottom.submitted.map(s => s.text)).toEqual(['also do X', '/compact'])
  })
})
