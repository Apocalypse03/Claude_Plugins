// Pure helpers: cron matching, durations and the ring drawing. No `$` here.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type Field = (value: number) => boolean

const parseField = (spec: string, min: number, max: number): Field | undefined => {
  const allowed = new Set<number>()
  for (const part of spec.split(',')) {
    const [range = '', stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return undefined
    let lo = min
    let hi = max
    if (range !== '*') {
      const [a = '', b] = range.split('-')
      lo = Number(a)
      hi = b === undefined ? (stepText === undefined ? lo : max) : Number(b)
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return undefined
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v)
  }
  return value => allowed.has(value)
}

/** The first time after `from` that a 5-field cron matches, in local time. */
export const nextFire = (cron: string, from: number): number | undefined => {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return undefined
  const [m = '', h = '', dom = '', mon = '', dow = ''] = parts
  const minute = parseField(m, 0, 59)
  const hour = parseField(h, 0, 23)
  const day = parseField(dom, 1, 31)
  const month = parseField(mon, 1, 12)
  const weekday = parseField(dow.replace(/\b7\b/g, '0'), 0, 6)
  if (!minute || !hour || !day || !month || !weekday) return undefined
  const isDayAny = dom === '*'
  const isWeekdayAny = dow === '*'

  const t = new Date(from)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const dayOk = isDayAny && isWeekdayAny
      ? true
      : isDayAny
        ? weekday(t.getDay())
        : isWeekdayAny
          ? day(t.getDate())
          : day(t.getDate()) || weekday(t.getDay())
    if (minute(t.getMinutes()) && hour(t.getHours()) && month(t.getMonth() + 1) && dayOk) {
      return t.getTime()
    }
    t.setMinutes(t.getMinutes() + 1)
  }
  return undefined
}

/** The gap between a cron's next two fires: its interval, near enough. */
export const cronInterval = (cron: string, from: number): number | undefined => {
  const first = nextFire(cron, from)
  const second = first === undefined ? undefined : nextFire(cron, first)
  return first === undefined || second === undefined ? undefined : second - first
}

/** "90s", "5m", "2h", "1h30m", "45" (minutes) -> milliseconds. */
export const parseDuration = (text: string): number | undefined => {
  const clean = text.trim().toLowerCase().replace(/\s+/g, '')
  if (/^\d+$/.test(clean)) return Number(clean) * MINUTE
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?:in)?)?(?:(\d+)s)?$/.exec(clean)
  if (!match || clean === '') return undefined
  const [, d = '0', h = '0', m = '0', s = '0'] = match
  const ms = Number(d) * DAY + Number(h) * HOUR + Number(m) * MINUTE + Number(s) * 1000
  return ms > 0 ? ms : undefined
}

/** 300000 -> "5m", 5400000 -> "1h30", 86400000 -> "1d". */
export const formatDuration = (ms: number): string => {
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`
  const minutes = Math.round(ms / MINUTE)
  if (minutes < 60) return `${minutes}m`
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`
}

/** Time left, finer than formatDuration: "3m 12s", "1h 04m", "40s". */
export const formatRemaining = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * The cron for "every `ms`", anchored at `now` where it needs an anchor, and
 * the interval it really gives (a cron cannot say every 90 minutes).
 */
export const durationToCron = (ms: number, now: number): { cron: string; intervalMs: number } => {
  const at = new Date(now)
  const minutes = Math.min(1440, Math.max(1, Math.round(ms / MINUTE)))
  if (minutes < 60) return { cron: `*/${minutes} * * * *`, intervalMs: minutes * MINUTE }
  if (minutes >= 1440) {
    return { cron: `${at.getMinutes()} ${at.getHours()} * * *`, intervalMs: DAY }
  }
  const hours = Math.round(minutes / 60)
  return { cron: `${at.getMinutes()} */${hours} * * *`, intervalMs: hours * HOUR }
}

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`)

/** The ring: `progress` 0..1 of the interval gone, the interval in the middle. */
export const ringSvg = (progress: number, label: string, isFiring: boolean): string => {
  const r = 15
  const c = 2 * Math.PI * r
  const p = Math.min(1, Math.max(0, progress))
  const size = label.length > 3 ? 8 : 10
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">` +
    `<style>.t{stroke:#8c8c8c40}.a{stroke:${isFiring ? '#5b9b5b' : '#d97757'}}.l{fill:#3d3d3a}` +
    `@media (prefers-color-scheme:dark){.t{stroke:#ffffff26}.l{fill:#e8e6dc}}</style>` +
    `<circle class="t" cx="18" cy="18" r="${r}" fill="none" stroke-width="3"/>` +
    `<circle class="a" cx="18" cy="18" r="${r}" fill="none" stroke-width="3" stroke-linecap="round" ` +
    `stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - p)).toFixed(2)}" ` +
    `transform="rotate(-90 18 18)"/>` +
    `<text class="l" x="18" y="18" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="${size}" font-weight="600">` +
    `${escapeXml(label)}</text></svg>`
  )
}

/** The terminal's ring: a quarter-step pie glyph. */
export const ringGlyph = (progress: number): string =>
  ['○', '◔', '◑', '◕', '●'][Math.min(4, Math.max(0, Math.floor(progress * 4)))] ?? '○'
