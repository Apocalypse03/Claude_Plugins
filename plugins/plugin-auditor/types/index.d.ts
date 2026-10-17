export type Usefulness = 'Keep' | 'Review' | 'Consider removing'

export type AuditRow = {
  id: string
  version: string
  scope: string
  enabled: boolean
  /** Always-on tokens from `claude plugin details`; null when unknown. */
  tokens: number | null
  mcpServers: string[]
  errors: string[]
  notes: string[]
  score: number
  usefulness: Usefulness
  reasons: string[]
  /** Full `claude plugin details` output, or the error that replaced it. */
  details: string
}

export type Audit = {
  /** ISO time the audit finished. */
  at: string
  /** Where the list came from. */
  source: 'cli' | 'settings'
  rows: AuditRow[]
  /** Set when the audit failed; rows is then empty. */
  error?: string
}

/** What the pane shows under the table. */
export type View =
  | { kind: 'details'; id: string }
  | { kind: 'confirm-remove'; id: string }
  | { kind: 'none' }

export type Progress = { isRunning: boolean; done: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'plugin-auditor': {
      audit: Audit | null
      view: View
      progress: Progress
      message: string
    }
  }
}
