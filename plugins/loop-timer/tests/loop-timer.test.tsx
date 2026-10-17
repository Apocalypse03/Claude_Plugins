import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { durationToCron, formatDuration, nextFire, parseDuration } from '../hooks/time'

const NOW = new Date(2026, 9, 15, 12, 0, 30).getTime()

const BAND = {
  plugin: 'loop-timer',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

type Call = { tool: string; input: Record<string, unknown> }

/** Stands in for the cron tools; records every call that reaches them. */
const world = (on: On) => {
  const calls: Call[] = []
  let nextId = 1
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', ($, e) => {
    const { tool, ...input } = e as unknown as { tool: string } & Record<string, unknown>
    calls.push({ tool, input })
    if (tool === 'CronCreate') {
      return { result: { id: `job${nextId++}`, humanSchedule: 'every few minutes', recurring: input.recurring !== false } }
    }
    if (tool === 'CronDelete') return { result: { id: String(input.id) } }
    if (tool === 'ScheduleWakeup') {
      const delay = Number(input.delaySeconds ?? 0)
      return {
        result: input.stop
          ? { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 }
          : { scheduledFor: clock.now() + delay * 1000, clampedDelaySeconds: delay, wasClamped: false },
      }
    }
    return { deny: `unexpected ${tool}` }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  on('ui.toast', () => ({ value: undefined }))
  return { calls, clock }
}

describe('time helpers', () => {
  test('parses and formats durations', () => {
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('10m')).toBe(600_000)
    expect(parseDuration('1h30m')).toBe(5_400_000)
    expect(parseDuration('45')).toBe(2_700_000)
    expect(parseDuration('soon')).toBeUndefined()
    expect(formatDuration(300_000)).toBe('5m')
    expect(formatDuration(5_400_000)).toBe('1h30')
    expect(formatDuration(86_400_000)).toBe('1d')
  })

  test('turns durations into crons and finds the next fire', () => {
    expect(durationToCron(600_000, NOW)).toEqual({ cron: '*/10 * * * *', intervalMs: 600_000 })
    expect(durationToCron(2 * 3_600_000, NOW).cron).toBe('0 */2 * * *')
    expect(nextFire('*/5 * * * *', NOW)).toBe(new Date(2026, 9, 15, 12, 5).getTime())
    expect(nextFire('30 14 * * *', NOW)).toBe(new Date(2026, 9, 15, 14, 30).getTime())
  })
})

test('a /loop cron shows as a ring with its interval, on desktop and terminal', async ($, on) => {
  world(on)
  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'check the deploy', recurring: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const ring = await desktop.find({ type: 'Svg' })
  expect(ring).toBeDefined()
  expect(JSON.stringify(await desktop.drawn())).toContain('every 5m')
  expect(JSON.stringify(await desktop.drawn())).toContain('next in 4m 30s')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: /5m/ })).toBeDefined()
  await terminal.unmount()
})

test('Stop deletes the cron and clears the ring', async ($, on) => {
  const { calls } = world(on)
  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'check the deploy', recurring: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'stop:job1' })
  expect(calls.at(-1)).toEqual({ tool: 'CronDelete', input: expect.objectContaining({ id: 'job1' }) })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
})

test('Change recreates the cron at the picked interval', async ($, on) => {
  const { calls } = world(on)
  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'check the deploy', recurring: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'change:job1' })
  await ui.press({ key: 'set:job1:10m' })
  const created = calls.filter(c => c.tool === 'CronCreate').at(-1)
  expect(created?.input).toMatchObject({ cron: '*/10 * * * *', prompt: 'check the deploy', recurring: true })
  expect(calls.some(c => c.tool === 'CronDelete' && c.input.id === 'job1')).toBe(true)
  expect(JSON.stringify(await ui.drawn())).toContain('every 10m')

  await ui.press({ key: 'change:job2' })
  await ui.input({ key: 'custom:job2', text: '2h' })
  expect(calls.filter(c => c.tool === 'CronCreate').at(-1)?.input.cron).toBe('0 */2 * * *')
})

test('a dynamic /loop wakeup shows, reschedules and stops', async ($, on) => {
  const { calls } = world(on)
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 1200, prompt: '/loop babysit', reason: 'r', noop: false })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await ui.drawn())).toContain('dynamic')
  expect(JSON.stringify(await ui.drawn())).toContain('next in 20m 00s')

  await ui.press({ key: 'change:wakeup' })
  await ui.press({ key: 'set:wakeup:5m' })
  expect(calls.at(-1)?.input).toMatchObject({ delaySeconds: 300, prompt: '/loop babysit' })
  expect(JSON.stringify(await ui.drawn())).toContain('next in 5m 00s')

  await ui.press({ key: 'stop:wakeup' })
  expect(calls.at(-1)?.input).toMatchObject({ stop: true })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
})
