import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMeasureInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-15T12:00:00Z')

const BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const capture = (on: On) => {
  const toasts: string[] = []
  mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // Stands in for another mod's box (or the engine's own) beneath this one.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="other-mod">
        <Text>other mod</Text>
      </Box>
    )
  })
  return { toasts }
}

const band = async ($: Engine) => JSON.stringify(await (await $.ui.mount(BAND)).drawn())

const measure = (fiveHour: number, weekly: number, usd: number): SessionMeasureInput => ({
  context: { window: 200_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(NOW + 2 * HOUR + 10 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: new Date(NOW + 76 * HOUR).toISOString() },
  ],
  cost: { usd },
  changed: ['rateLimits', 'cost'],
})

test('draws its own box above the other boxes in the band', async ($, on) => {
  const { toasts } = capture(on)
  await $.session.measure(measure(42, 18.5, 1.234))
  const drawn = await band($)
  expect(drawn).toContain('5-hour 42% (resets in 2h 10m)  ·  Weekly 19% (resets in 3d 4h)  ·  Session $1.23')
  expect(drawn).toContain('"borderStyle":"round"')
  expect(drawn.indexOf('Session $1.23')).toBeLessThan(drawn.indexOf('other mod'))
  expect(toasts).toEqual([])
})

test('yields the band to a survey', async ($, on) => {
  capture(on)
  await $.session.measure(measure(42, 18.5, 1.234))
  const drawn = JSON.stringify(await (await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })).drawn())
  expect(drawn).not.toContain('Session $1.23')
  expect(drawn).toContain('other mod')
})

test('warns once per cost threshold, naming the highest crossed', async ($, on) => {
  const { toasts } = capture(on)
  await $.session.measure(measure(10, 5, 5.5))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('$5.50')
  expect(toasts[0]).toContain('$5.00 mark')
  expect(await band($)).toContain('⚠ Session $5.50')
  await $.session.measure(measure(11, 5, 6))
  expect(toasts.length).toBe(1)
  await $.session.measure(measure(11, 5, 10.2))
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toContain('$10.00 mark')
})

test('warns when a limit window passes a threshold', async ($, on) => {
  const { toasts } = capture(on)
  await $.session.measure(measure(91, 20, 0.5))
  expect(toasts).toEqual(['5-hour limit at 91%, resets in 2h 10m.'])
  expect(await band($)).toContain('⚠ 5-hour 91%')
  await $.session.measure(measure(93, 20, 0.6))
  expect(toasts.length).toBe(1)
})

test('custom thresholds come from the settings', { options: { costWarnings: '0.5', limitWarnings: '' } }, async ($, on) => {
  const { toasts } = capture(on)
  await $.session.measure(measure(99, 99, 0.75))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('$0.50 mark')
})

test('shows usage as soon as the session starts', async ($, on) => {
  capture(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  expect(await band($)).toContain('Session $0.00')
})
