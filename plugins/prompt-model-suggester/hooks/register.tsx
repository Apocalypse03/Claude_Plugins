import type { On } from 'claude-code'

const TIERS = ['haiku', 'sonnet', 'opus'] as const
type Tier = (typeof TIERS)[number]

const RUBRIC = [
  'Pick the cheapest Claude model tier that can handle this request well.',
  'haiku: quick questions, lookups, renames, one-line fixes, formatting.',
  'sonnet: everyday coding, debugging with a known cause, edits across a few files.',
  'opus: architecture, hard bugs, large refactors, long multi-step reasoning.',
  '',
  'Request:',
].join('\n')

// Module-scoped state. A hot reload starts it over, which only drops a choice in flight.
type Pending = { text: string; recommended: Tier; choice: Tier; isFallback: boolean }
let pending: Pending | null = null
let armed: { text: string; model: Tier } | null = null
let active: { turnId: string; model: Tier } | null = null

const NEXT: Record<Tier, Tier> = { haiku: 'sonnet', sonnet: 'opus', opus: 'haiku' }
const nextTier = (tier: Tier): Tier => NEXT[tier]

export function register(on: On) {
  on('prompt.submit', async ($, e, next) => {
    // Only gate prompts the person typed at an idle prompt; leave everything else alone,
    // including our own resubmission (a plugin's $.prompt.submit skips its own hook anyway).
    const isGated =
      e.origin.kind === 'composer' &&
      e.turnId === undefined &&
      e.attachments === undefined &&
      e.text.trim() !== '' &&
      !e.text.startsWith('/')
    if (!isGated) {
      return next(e)
    }

    let recommended: Tier = 'sonnet'
    let isFallback = true
    try {
      const label = await $.model.classify(`${RUBRIC}\n${e.text}`, TIERS, { model: 'haiku' })
      if (label === 'haiku' || label === 'sonnet' || label === 'opus') {
        recommended = label
        isFallback = false
      }
    } catch {
      // Classifier unavailable: keep the sonnet default and still show the band.
    }

    pending = { text: e.text, recommended, choice: recommended, isFallback }
    $.ui.invalidate('ui.render')

    return { drop: `Model suggestion: ${recommended}. Choose in the band above the prompt to run it.` }
  }).catch(($, e, next) => {
    // Fail open: a broken gate must never swallow the person's prompt.
    pending = null
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (armed !== null && armed.text === e.text) {
      active = { turnId: e.turnId, model: armed.model }
      $.ui.status(`Model this turn: ${armed.model}`)
    }
    armed = null
    return next(e)
  })

  // Applies the chosen model to every main-loop request of the chosen turn.
  on('turn.step', async function* ($, e, next) {
    if (active !== null && e.turnId === active.turnId && e.agentId === undefined) {
      return yield* next({ ...e, model: active.model })
    }
    return yield* next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (active !== null && e.turnId === active.turnId) {
      active = null
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    // The band is one shared instance: draw only while we have a choice pending, and
    // yield to surveys and to subagent transcripts so other UI keeps its place.
    if (pending === null || e.props.hasSurvey || e.props.view.agentId !== undefined) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const { choice, recommended, isFallback } = pending
    const note = isFallback ? ' (classifier unavailable)' : choice === recommended ? '' : ` (suggested ${recommended})`

    const run = async () => {
      if (pending === null) return
      const { text, choice } = pending
      // Armed here, consumed by the turn.start of this exact text, applied by turn.step.
      armed = { text, model: choice }
      pending = null
      $.ui.invalidate('ui.render')
      await $.prompt.submit({ text, asUser: true })
    }
    const cycle = () => {
      if (pending === null) return
      pending = { ...pending, choice: nextTier(pending.choice) }
      $.ui.invalidate('ui.render')
    }
    const edit = async () => {
      if (pending === null) return
      const { text } = pending
      pending = null
      $.ui.invalidate('ui.render')
      await $.prompt.fill({ text, mode: 'replace' })
    }

    return (
      <Box flexDirection="row">
        <Text>
          Model: <Text bold>{choice}</Text>
          <Text dimColor>{note} </Text>
        </Text>
        <Button key="accept" label={`Run on ${choice}`} variant="primary" hotkey="a" onPress={run} />
        <Text> </Text>
        <Button key="cycle" label={`→ ${nextTier(choice)}`} hotkey="c" onPress={cycle} />
        <Text> </Text>
        <Button key="edit" label="Edit" hotkey="e" onPress={edit} />
      </Box>
    )
  })
}
