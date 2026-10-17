export type Reading = {
  fiveHour?: { percent: number; resetsAt?: string }
  weekly?: { percent: number; resetsAt?: string }
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      /** Cost thresholds (USD) already warned about this session. */
      costWarned: number[]
      /** `<window>:<percent>` limit thresholds already warned about. */
      limitWarned: string[]
      /** The last usage reading, drawn in the band above the prompt. */
      latest: Reading
      /** When the band's countdowns were last brought current (ms). */
      now: number
    }
  }
}
