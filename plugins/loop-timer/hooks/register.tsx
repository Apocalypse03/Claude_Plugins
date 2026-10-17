import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Loop } from '../types'
import {
  cronInterval,
  durationToCron,
  formatDuration,
  formatRemaining,
  nextFire,
  parseDuration,
  ringGlyph,
  ringSvg,
} from './time'

const loops = atom({ plugin: 'loop-timer', key: 'loops' } as const, [] as Loop[])
const now = atom({ plugin: 'loop-timer', key: 'now' } as const, 0)
const editing = atom({ plugin: 'loop-timer', key: 'editing' } as const, null as string | null)

const TICK_MS = 2_000
const WEEK_MS = 7 * 24 * 3_600_000
const PRESETS = ['1m', '5m', '10m', '15m', '30m', '1h'] as const

const upsert = (list: Loop[], loop: Loop) => [...list.filter(l => l.id !== loop.id), loop]
const remove = (list: Loop[], id: string) => list.filter(l => l.id !== id)

function cronLoop(id: string, cron: string, prompt: string, recurring: boolean, at: number): Loop {
  const nextAt = nextFire(cron, at) ?? at + 60_000
  return {
    id,
    kind: 'cron',
    prompt,
    cron,
    recurring,
    intervalMs: recurring ? (cronInterval(cron, at) ?? nextAt - at) : nextAt - at,
    nextAt,
    createdAt: at,
  }
}

/** Moves fired crons on to their next fire, and drops finished or expired ones. */
async function tick($: EngineInterface) {
  const list = await read($, loops)
  if (list.length === 0) return
  const at = await $.clock.now()
  await update($, now, () => at)
  const isStale = list.some(l => l.kind === 'cron' && at >= l.nextAt)
  if (!isStale) return
  await update($, loops, current =>
    current.flatMap(l => {
      if (l.kind !== 'cron' || at < l.nextAt) return [l]
      if (!l.recurring || at - l.createdAt > WEEK_MS || !l.cron) return []
      return [{ ...l, nextAt: nextFire(l.cron, at) ?? at + l.intervalMs }]
    }),
  )
}

async function fail($: EngineInterface, what: string, error: unknown) {
  $.ui.toast(`loop-timer: could not ${what}: ${error instanceof Error ? error.message : String(error)}`)
}

async function stopLoop($: EngineInterface, id: string) {
  const loop = (await read($, loops)).find(l => l.id === id)
  if (!loop) return
  try {
    const ran =
      loop.kind === 'cron'
        ? await $.tool.call({ tool: 'CronDelete', id: loop.id })
        : await $.tool.call({ tool: 'ScheduleWakeup', stop: true })
    if (ran.deny !== undefined) return fail($, 'stop the loop', ran.deny)
    if (ran.isError) return fail($, 'stop the loop', ran.text ?? 'the tool failed')
    await update($, loops, list => remove(list, id))
    await update($, editing, () => null)
    $.ui.toast(`Stopped loop: ${loop.prompt.slice(0, 60)}`)
  } catch (error) {
    await fail($, 'stop the loop', error)
  }
}

async function retime($: EngineInterface, id: string, text: string) {
  const loop = (await read($, loops)).find(l => l.id === id)
  const ms = parseDuration(text)
  if (!loop) return
  if (ms === undefined) {
    $.ui.toast(`loop-timer: "${text}" is not a duration. Try 90s, 10m, 2h or 1h30m.`)
    return
  }
  try {
    if (loop.kind === 'cron') {
      const { cron, intervalMs } = durationToCron(ms, await $.clock.now())
      const deleted = await $.tool.call({ tool: 'CronDelete', id: loop.id })
      if (deleted.deny !== undefined || deleted.isError) {
        return fail($, 'change the interval', deleted.deny ?? deleted.text ?? 'CronDelete failed')
      }
      await update($, loops, list => remove(list, id))
      const created = await $.tool.call({
        tool: 'CronCreate',
        cron,
        prompt: loop.prompt,
        recurring: loop.recurring,
      })
      if (created.deny !== undefined || created.isError || !created.result) {
        return fail($, 'recreate the loop', created.deny ?? created.text ?? 'CronCreate failed')
      }
      // This mod's own tool calls skip its own hooks, so it records the new job here.
      const fresh = cronLoop(created.result.id, cron, loop.prompt, loop.recurring, await $.clock.now())
      await update($, loops, list => upsert(list, fresh))
      const note = intervalMs !== ms ? ` (a cron can't do ${formatDuration(ms)}, so rounded)` : ''
      $.ui.toast(`Loop now runs every ${formatDuration(intervalMs)}${note}.`)
    } else {
      const seconds = Math.min(3600, Math.max(60, Math.round(ms / 1000)))
      await $.tool.call({ tool: 'ScheduleWakeup', stop: true })
      const ran = await $.tool.call({
        tool: 'ScheduleWakeup',
        delaySeconds: seconds,
        prompt: loop.prompt,
        reason: `Interval changed to ${formatDuration(seconds * 1000)} from the loop timer`,
        noop: false,
      })
      if (ran.deny !== undefined || ran.isError || !ran.result) {
        return fail($, 'reschedule the loop', ran.deny ?? ran.text ?? 'ScheduleWakeup failed')
      }
      const { scheduledFor, clampedDelaySeconds } = ran.result
      await update($, loops, list =>
        upsert(list, { ...loop, intervalMs: clampedDelaySeconds * 1000, nextAt: scheduledFor, isFiring: false }),
      )
      $.ui.toast(`Next wakeup in ${formatDuration(seconds * 1000)}. Claude still picks the pace after that.`)
    }
    await update($, editing, () => null)
  } catch (error) {
    await fail($, 'change the interval', error)
  }
}

export const register: Register = on => {
  let ticker: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($))
    return result
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    return next(e)
  })

  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.result && !ran.isError) {
      const loop = cronLoop(ran.result.id, e.cron, e.prompt, ran.result.recurring, await $.clock.now())
      await update($, loops, list => upsert(list, loop))
      await update($, now, () => loop.createdAt)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'CronDelete' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.isError && ran.deny === undefined) await update($, loops, list => remove(list, e.id))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'CronList' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.result && !ran.isError) {
      const at = await $.clock.now()
      const jobs = ran.result.jobs
      await update($, loops, list => [
        ...list.filter(l => l.kind === 'wakeup' || jobs.some(j => j.id === l.id)),
        ...jobs
          .filter(j => !list.some(l => l.id === j.id))
          .map(j => cronLoop(j.id, j.cron, j.prompt, j.recurring ?? true, at)),
      ])
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.result || ran.isError) return ran
    if (e.stop || ran.result.stopped) {
      await update($, loops, list => remove(list, 'wakeup'))
      return ran
    }
    const at = await $.clock.now()
    const loop: Loop = {
      id: 'wakeup',
      kind: 'wakeup',
      prompt: e.prompt ?? '',
      recurring: true,
      intervalMs: ran.result.clampedDelaySeconds * 1000,
      nextAt: ran.result.scheduledFor,
      createdAt: at,
    }
    await update($, loops, list => upsert(list, loop))
    await update($, now, () => at)
    return ran
  }).catch(($, e, next) => next(e))

  // A loop firing: line the ring up with the real fire time.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'scheduled-trigger') {
      const at = await $.clock.now()
      await update($, loops, list =>
        list.map(l => {
          if (l.kind === 'wakeup') return at >= l.nextAt - 5_000 ? { ...l, isFiring: true } : l
          const isThis = l.prompt === e.text || Math.abs(l.nextAt - at) < 90_000
          if (!isThis || !l.recurring) return l
          return { ...l, nextAt: l.cron ? (nextFire(l.cron, at) ?? at + l.intervalMs) : at + l.intervalMs }
        }),
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A dynamic loop that fired and was not rescheduled has ended.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await update($, loops, list => list.filter(l => !(l.kind === 'wakeup' && l.isFiring)))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, loops)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const Input = 'Input' in elements ? elements.Input : undefined
    const at = Math.max(await read($, now), await $.clock.now())
    const open = await read($, editing)
    const sorted = [...list].sort((a, b) => a.nextAt - b.nextAt)
    // What the plugins beneath draw (usage-meter's box) stays, above the loops.
    const above = await next(e)

    return (
      <Box flexDirection="column" gap={1}>
        {above}
        {sorted.map((loop, index) => {
          const left = loop.nextAt - at
          const progress = loop.isFiring ? 1 : 1 - left / Math.max(1, loop.intervalMs)
          const label = formatDuration(loop.intervalMs)
          const kind = loop.kind === 'wakeup' ? 'dynamic' : loop.recurring ? `every ${label}` : 'once'
          const when = loop.isFiring
            ? 'running now'
            : left <= 0
              ? 'due, waits for Claude to be idle'
              : `next in ${formatRemaining(left)}`
          const isFirst = index === 0
          const isEditing = open === loop.id
          return (
            <Box key={`loop:${loop.id}`} flexDirection="column">
              <Box flexDirection="row" alignItems="center" gap={1}>
                {Svg ? (
                  <Svg
                    source={ringSvg(progress, label, loop.isFiring === true)}
                    alt={`Loop timer: ${kind}, ${when}`}
                    width={36}
                    height={36}
                  />
                ) : (
                  <Text color="#d97757">
                    {ringGlyph(progress)} {label}
                  </Text>
                )}
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate">{loop.prompt || '(dynamic loop)'}</Text>
                  <Text dimColor wrap="truncate">
                    {kind} · {when}
                  </Text>
                </Box>
                <Button
                  key={`change:${loop.id}`}
                  label={isEditing ? 'Cancel' : 'Change'}
                  hotkey={isFirst ? 'c' : undefined}
                  dimColor
                  onPress={() => void update($, editing, cur => (cur === loop.id ? null : loop.id))}
                />
                <Button
                  key={`stop:${loop.id}`}
                  label="Stop"
                  hotkey={isFirst ? 's' : undefined}
                  onPress={() => void stopLoop($, loop.id)}
                />
              </Box>
              {isEditing && (
                <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
                  <Text dimColor>{loop.kind === 'wakeup' ? 'Next wakeup in' : 'Run every'}</Text>
                  {PRESETS.map(preset => (
                    <Button
                      key={`set:${loop.id}:${preset}`}
                      label={preset}
                      variant={formatDuration(parseDuration(preset) ?? 0) === label ? 'primary' : undefined}
                      onPress={() => void retime($, loop.id, preset)}
                    />
                  ))}
                  {Input && (
                    <Input
                      key={`custom:${loop.id}`}
                      placeholder="or type 20m, 2h, 1h30m"
                      submitLabel="set"
                      autoFocus
                      onSubmit={value => void retime($, loop.id, value)}
                    />
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
