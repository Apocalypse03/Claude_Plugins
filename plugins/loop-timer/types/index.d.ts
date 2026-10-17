export type Loop = {
  /** The cron job's id, or `wakeup` for a dynamic /loop's next wakeup. */
  id: string
  kind: 'cron' | 'wakeup'
  prompt: string
  cron?: string
  recurring: boolean
  /** Time between fires; for a wakeup, its delay. */
  intervalMs: number
  /** When it fires next, in `$.clock.now()` milliseconds. */
  nextAt: number
  createdAt: number
  /** A wakeup that fired and has not been rescheduled yet. */
  isFiring?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'loop-timer': {
      loops: Loop[]
      /** The clock as of the last tick; drawing reads it so the rings move. */
      now: number
      /** The loop whose interval picker is open. */
      editing: string | null
    }
  }
}
