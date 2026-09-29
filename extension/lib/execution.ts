/**
 * The run loop — audit findings 1.1 and 1.2.
 *
 * This is deliberately a PURE module with no `chrome.*` in it. Two reasons:
 *
 *  1. Correctness. The old loop lived inside the service worker, which meant
 *     every branch of it was untestable. That is how `ok` came to be
 *     destructured and then ignored: nothing could fail, so nothing did.
 *
 *  2. The confirmation path. The SW, the content script and the panel each
 *     held a piece of it, and the pieces did not line up. Keeping the policy
 *     here means "does the human actually get asked?" is a unit test rather
 *     than a three-file integration puzzle.
 *
 * The loop's contract, stated once:
 *
 *   - A step that fails STOPS the run. Later steps may depend on it, and
 *     clicking through a failure is how an agent deletes the wrong thing.
 *   - A step that needs confirmation BLOCKS until the human answers. A
 *     timeout is a decline, never an approval.
 *   - A decline is recorded as a decline. It is not a success and not a page
 *     failure, and the run stops all the same.
 */

export const MAX_STEPS_PER_PLAN = 20

/**
 * Actions the loop must never perform on its own authority.
 *
 * Note there is deliberately NO whitelist of dispatchable actions. The content
 * script is the single authority on which verbs exist; a second list here would
 * drift from it and would silently reject any action added later. An unknown
 * verb is dispatched and the page reports on it.
 */
const NEEDS_HUMAN = new Set(['ask_user'])

export interface PlanStep {
  action: string
  target?: { mark?: number; selector?: string; role?: string; name?: string }
  value?: string
  text?: string
  url?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  reason?: string
}

/** What the page reported about one dispatched step. */
export interface StepResult {
  ok: boolean
  action: string
  /** Wall time of the dispatch, measured by the caller. */
  ms?: number
  /** The step is unsafe until a human approves it. */
  needsConfirm?: boolean
  /** Why confirmation is needed — shown verbatim to the user. */
  reason?: string
  /** Why the step failed. Surfaced to the user; never swallowed. */
  error?: string
  /**
   * Evidence that the step actually took effect. `unknown` is a valid, honest
   * answer and is the default — a dispatch that returns without error proves
   * nothing about the page.
   */
  effect?: 'confirmed' | 'changed' | 'unchanged' | 'unknown'
}

export type StepEvent =
  | { type: 'executed'; index: number; ms: number; effect: StepResult['effect'] }
  | { type: 'failed'; index: number; reason: string; retryable: boolean }
  | { type: 'confirmed'; index: number }
  | { type: 'declined'; index: number; reason: string }
  | { type: 'wait'; index: number; ms: number }
  | { type: 'capped'; requested: number; ran: number }

export interface PlanRunResult {
  ok: boolean
  executed: number
  halted: number
  failed: number
  /** Index of the step that ended the run, or null if it ran to completion. */
  stoppedAt: number | null
  events: StepEvent[]
}

/**
 * The seam between the loop and the browser.
 *
 * `run` dispatches one step to the page. `ask` blocks on a human and resolves
 * true only for an explicit approval — it must never resolve true on timeout.
 */
export interface StepDriver {
  run(index: number, step: PlanStep): Promise<StepResult>
  ask(index: number, reason: string): Promise<boolean>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Run a plan to completion or to its first real failure.
 *
 * A step is retried exactly once, and only when the page refused it *pending
 * approval* — never after a genuine failure. Retrying a failed destructive
 * action is how you double-pay.
 */
export async function runPlan(
  plan: { steps: PlanStep[] },
  driver: StepDriver,
): Promise<PlanRunResult> {
  const events: StepEvent[] = []
  const requested = plan.steps.length
  const limit = Math.min(requested, MAX_STEPS_PER_PLAN)

  let executed = 0
  let halted = 0
  let failed = 0
  let stoppedAt: number | null = null
  let ok = true

  for (let i = 0; i < limit; i++) {
    const step = plan.steps[i]!
    const action = String(step.action)

    // The model declined to act. Nothing after it is meaningful.
    if (action === 'none') {
      stoppedAt = i
      break
    }

    if (action === 'wait_for') {
      const ms = Math.min(3000, Math.max(0, Number(step.amount ?? 300)))
      await sleep(ms)
      events.push({ type: 'wait', index: i, ms })
      continue
    }

    const reason = step.reason ?? 'This step needs your confirmation.'

    // Ask BEFORE dispatching: `ask_user` is a question, not an action.
    if (NEEDS_HUMAN.has(action)) {
      halted++
      const approved = await driver.ask(i, reason)
      if (!approved) {
        events.push({ type: 'declined', index: i, reason })
        stoppedAt = i
        ok = false
        break
      }
      events.push({ type: 'confirmed', index: i })
      // Confirmed: the real work happens in the dispatch below.
    }

    let res = await driver.run(i, step)

    if (res.needsConfirm) {
      // The PAGE found the step unsafe. This is the path that was dead: the SW
      // used to forward `needsConfirm` as a plain chat answer, so the confirm
      // card never rendered and the run blocked on an empty map for 60s.
      halted++
      const approved = await driver.ask(i, res.reason ?? 'This step needs your confirmation.')
      if (!approved) {
        events.push({ type: 'declined', index: i, reason: res.reason ?? 'confirmation declined' })
        stoppedAt = i
        ok = false
        break
      }
      events.push({ type: 'confirmed', index: i })
      // Exactly one retry, and only because a human approved this specific step.
      res = await driver.run(i, step)
    }

    if (!res.ok) {
      failed++
      stoppedAt = i
      ok = false
      events.push({
        type: 'failed',
        index: i,
        reason: res.error ?? 'the page did not accept the action',
        // A refused action is retriable only if a human already approved it.
        retryable: false,
      })
      break
    }

    executed++
    events.push({ type: 'executed', index: i, ms: res.ms ?? 0, effect: res.effect ?? 'unknown' })
  }

  if (requested > limit) events.push({ type: 'capped', requested, ran: limit })

  return { ok, executed, halted, failed, stoppedAt, events }
}
