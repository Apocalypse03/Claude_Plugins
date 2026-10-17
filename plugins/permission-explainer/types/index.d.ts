/** One labelled line of an explanation: `What`, `Why`, `Options`, `If approved`, `If denied`. */
export type ExplanationLine = { label: string; text: string }

/** The explanation of one pending permission request. */
export type Explanation = {
  /** The call's tool_use_id when it could be matched, else a minted `req-<n>` id. */
  id: string
  tool: string
  lines: ExplanationLine[]
  source: 'haiku' | 'template'
}

declare module 'claude-code' {
  interface PluginState {
    'permission-explainer': { pending: Explanation[] }
  }
}
