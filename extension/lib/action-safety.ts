/**
 * Action-safety policy: what must be confirmed before the agent acts.
 *
 * Extracted from content.ts so the rules are testable without a browser and so
 * the reasoning is written down in one place. executeAction applies this; the
 * switch statement below is the only thing that performs the effect.
 *
 * Two independent axes decide whether an action proceeds:
 *
 *   1. WHAT the action is. `submit`, `send`, `pay`, `delete` are destructive
 *      whatever they land on, so they always need a human click.
 *   2. WHAT it landed on. A mark is an index into a snapshot, so a re-render
 *      can make it resolve to a different node — and that node might hold
 *      something sensitive. The original plan never saw it.
 *
 * Axis 2 is the one that was missing. `fill` had a guard; `click`, `focus` and
 * `select` had none, and every guard ran against the originally-resolved node.
 */

export const DESTRUCTIVE_ACTIONS = new Set(['submit', 'send', 'pay', 'delete'])

/** Verb-ish words in a control's own text that make an action destructive. */
export const DESTRUCTIVE_WORDS =
  /\b(submit|send|pay|delete|confirm order|place order|transfer|withdraw|proceed|continue as)\b/i

export type ActionName =
  | 'click' | 'fill' | 'focus' | 'select' | 'scroll' | 'hover'
  | 'navigate' | 'extract' | 'wait_for' | 'ask_user' | 'none'

export interface SafetyInput {
  action: string
  /** The control's accessible name + button text, post-resolution. */
  verb?: string
  /** True when resolveMark returned 'reassigned' — a different node than planned. */
  rerolled?: boolean
  /** True when the resolved element classifies as sensitive (L0 semantics). */
  targetSensitive?: boolean
}

export interface SafetyVerdict {
  confirm: boolean
  /** User-facing, or null when the action may proceed unattended. */
  reason: string | null
  /** Which rule fired — for the ledger and for tests. */
  rule: 'none' | 'destructive_action' | 'destructive_verb' | 'reroll_into_sensitive' | 'fill_into_sensitive'
}

/**
 * Decide whether an action needs an explicit human click.
 *
 * Order matters only for the message: the most specific reason wins, so the
 * user is told the true cause rather than the first one that matched.
 */
export function decideSafety(input: SafetyInput): SafetyVerdict {
  const action = (input.action ?? '').toLowerCase()

  // A no-op never acts, so it never needs consent. Checked first so `none` on
  // a rerolled sensitive target does not raise a pointless dialog.
  if (action === 'none' || action === 'ask_user' || action === 'wait_for') {
    return { confirm: false, reason: null, rule: 'none' }
  }

  const verb = input.verb ?? ''

  // Axis 1 — the action itself is irreversible.
  if (DESTRUCTIVE_ACTIONS.has(action)) {
    return {
      confirm: true,
      reason: `About to ${action} — confirm?`,
      rule: 'destructive_action',
    }
  }
  if (DESTRUCTIVE_WORDS.test(verb)) {
    return {
      confirm: true,
      reason: `About to ${action || 'act'} on a control that reads "${verb.slice(0, 40)}" — confirm?`,
      rule: 'destructive_verb',
    }
  }

  // Axis 2 — the node is sensitive, and (for a fill) that is already terminal.
  if (input.targetSensitive && action === 'fill') {
    return {
      confirm: true,
      reason: 'That field holds something sensitive. Fill it in yourself?',
      rule: 'fill_into_sensitive',
    }
  }

  // The reroll case: the plan targeted a DIFFERENT node than the one it
  // reasoned about, and that node holds something sensitive. Without this a
  // "click mark 17" could quietly become a click on the Aadhaar field.
  if (input.rerolled && input.targetSensitive) {
    return {
      confirm: true,
      reason: `That control moved and now looks sensitive (${action}). Continue?`,
      rule: 'reroll_into_sensitive',
    }
  }

  return { confirm: false, reason: null, rule: 'none' }
}
