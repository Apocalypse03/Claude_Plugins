import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCost, SessionRateLimit, Timer } from 'claude-code'

import type { Reading } from '../types'

const costWarned = atom({ plugin: 'usage-meter', key: 'costWarned' } as const, [] as number[])
const limitWarned = atom({ plugin: 'usage-meter', key: 'limitWarned' } as const, [] as string[])
const latest = atom({ plugin: 'usage-meter', key: 'latest' } as const, {} as Reading)
const now = atom({ plugin: 'usage-meter', key: 'now' } as const, 0)

const WINDOWS = [
  { field: 'fiveHour', kind: 'five_hour', label: '5-hour' },
  { field: 'weekly', kind: 'seven_day', label: 'Weekly' },
] as const

/** "2, 5, 10" -> [2, 5, 10]; anything unparseable is dropped. */
export const parseSteps = (value: unknown): number[] =>
  String(value ?? '')
    .split(',')
    .map(part => Number(part.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)

export const toReading = (rateLimits: readonly SessionRateLimit[], cost?: SessionCost): Reading => {
  const reading: Reading = { usd: cost?.usd }
  for (const { field, kind } of WINDOWS) {
    const limit = rateLimits.find(r => r.kind === kind)
    if (limit) reading[field] = { percent: limit.percentUsed, resetsAt: limit.resetsAt }
  }
  return reading
}

/** Milliseconds until an ISO timestamp, as "3d 4h", "2h 10m" or "12m". */
export const formatUntil = (resetsAt: string | undefined, now: number): string | undefined => {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (!Number.isFinite(at)) return undefined
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

const formatUsd = (usd: number) => `$${usd.toFixed(2)}`

export const formatLine = (
  reading: Reading,
  now: number,
  costSteps: readonly number[],
  limitSteps: readonly number[],
): string => {
  const parts: string[] = []
  for (const { field, label } of WINDOWS) {
    const window = reading[field]
    if (!window) continue
    const until = formatUntil(window.resetsAt, now)
    const flag = window.percent >= (limitSteps[0] ?? Infinity) ? '⚠ ' : ''
    parts.push(`${flag}${label} ${Math.round(window.percent)}%${until ? ` (resets in ${until})` : ''}`)
  }
  if (reading.usd !== undefined) {
    const flag = reading.usd >= (costSteps[0] ?? Infinity) ? '⚠ ' : ''
    parts.push(`${flag}Session ${formatUsd(reading.usd)}`)
  }
  return parts.length > 0 ? parts.join('  ·  ') : 'Usage: waiting for the first reply'
}

type Meter = {
  costSteps: number[]
  limitSteps: number[]
  last: Reading
  ticker?: Timer
}

/** Writes what the band draws from; the write redraws it. */
async function draw($: EngineInterface, meter: Meter) {
  const at = await $.clock.now()
  await update($, latest, () => meter.last)
  await update($, now, () => at)
}

async function warnCost($: EngineInterface, meter: Meter) {
  const usd = meter.last.usd
  if (usd === undefined) return
  const warned = await read($, costWarned)
  const crossed = meter.costSteps.filter(step => usd >= step && !warned.includes(step))
  if (crossed.length === 0) return
  await update($, costWarned, list => [...list, ...crossed])
  const step = crossed[crossed.length - 1] ?? 0
  $.ui.toast(
    `This session has cost ${formatUsd(usd)} so far (past your ${formatUsd(step)} mark). ` +
      'Consider /compact or starting fresh with /clear.',
    { timeoutMs: 10_000 },
  )
}

async function warnLimits($: EngineInterface, meter: Meter) {
  const now = await $.clock.now()
  const warned = await read($, limitWarned)
  const fresh: string[] = []
  for (const { field, label } of WINDOWS) {
    const window = meter.last[field]
    if (!window) continue
    // Keyed by reset time, so each new window warns again.
    const keyOf = (step: number) => `${field}:${step}:${window.resetsAt ?? ''}`
    const crossed = meter.limitSteps.filter(step => window.percent >= step && !warned.includes(keyOf(step)))
    if (crossed.length === 0) continue
    fresh.push(...crossed.map(keyOf))
    const until = formatUntil(window.resetsAt, now)
    $.ui.toast(
      `${label} limit at ${Math.round(window.percent)}%${until ? `, resets in ${until}` : ''}.`,
      { timeoutMs: 10_000 },
    )
  }
  if (fresh.length > 0) await update($, limitWarned, list => [...list.slice(-50), ...fresh])
}

async function take(
  $: EngineInterface,
  meter: Meter,
  rateLimits: readonly SessionRateLimit[],
  cost?: SessionCost,
) {
  meter.last = toReading(rateLimits, cost)
  await draw($, meter)
  await warnCost($, meter)
  await warnLimits($, meter)
}

export const register: Register = (on, options) => {
  const meter: Meter = {
    costSteps: parseSteps(options.costWarnings),
    limitSteps: parseSteps(options.limitWarnings),
    last: {},
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await take($, meter, usage.rateLimits, usage.cost)
    // Keep the "resets in" countdowns current between turns.
    meter.ticker?.cancel()
    meter.ticker = $.clock.every(60_000, () => void draw($, meter))
    // Earlier versions drew in the status line; clear what they left there.
    $.ui.status(undefined)
    return result
  })

  // Its own box at the top of the band above the prompt: everything the
  // plugins beneath draw there (and the engine's own) stays, stacked under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    const reading = await read($, latest)
    const at = Math.max(await read($, now), await $.clock.now())
    const { Box, Text } = $.ui.resolve(e)
    const line = formatLine(reading, at, meter.costSteps, meter.limitSteps)
    return (
      <Box flexDirection="column">
        <Box key="usage-meter" borderStyle="round" borderColor={line.includes('⚠') ? 'yellow' : 'gray'} paddingX={1}>
          <Text dimColor>Usage </Text>
          <Text wrap="wrap">{line}</Text>
        </Box>
        {below}
      </Box>
    )
  })

  on('session.measure', async ($, e, next) => {
    await take($, meter, e.rateLimits, e.cost)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // /clear starts the session's cost over, so its warnings start over too.
      await update($, costWarned, () => [])
    }
    return next(e)
  })
}
