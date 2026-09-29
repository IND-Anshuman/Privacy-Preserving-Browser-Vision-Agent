import { describe, it, expect } from 'vitest'
import { runPlan, MAX_STEPS_PER_PLAN } from '../lib/execution'
import type { PlanStep, StepResult, StepEvent, PlanRunResult } from '../lib/execution'

/**
 * The run loop, extracted from the service worker.
 *
 * Audit finding 1.2: `background.ts` destructured `ok` out of every step result
 * and then never read it, so a failed step advanced the plan exactly like a
 * successful one. A click on a disabled button and a successful fill were
 * indistinguishable to the loop.
 *
 * Audit finding 1.1: the loop's confirmation path was unreachable. The content
 * script returned `needsConfirm`, the SW forwarded it as a plain panel *answer*
 * (a chat bubble), and the confirm card was only ever rendered from
 * `execute:confirm_required` — which nothing sent. The user got a text bubble,
 * the run blocked on an empty map for 60 seconds, and then reported "Cancelled
 * at your request."
 *
 * Both are properties of the LOOP, not of any one transport, so the loop is
 * testable here with a fake driver and no browser at all.
 */

const step = (action: string, extra: Partial<PlanStep> = {}): PlanStep =>
  ({ action, ...extra }) as PlanStep

/** A driver that records what the loop asked for and replays canned results. */
function driver(
  results: Record<number, Partial<StepResult>> = {},
  answers: boolean[] = [],
): { d: import('../lib/execution').StepDriver; asked: number[]; executed: number[] } {
  const asked: number[] = []
  const executed: number[] = []
  let n = 0
  return {
    asked,
    executed,
    d: {
      async run(index, s) {
        executed.push(index)
        return { ok: true, action: String(s.action), ms: 1, ...results[index] } as StepResult
      },
      async ask(index) {
        asked.push(index)
        return answers[asked.length - 1] ?? true
      },
    },
  }
}

describe('a failed step stops the run', () => {
  it('does not execute any step after the failure', async () => {
    const { d, executed } = driver({ 1: { ok: false, error: 'element is disabled' } })
    const res = await runPlan(
      { steps: [step('click'), step('click'), step('fill')] },
      d,
    )
    // Steps 0 and 1 ran; step 2 must never be attempted — its target may well
    // depend on what the failed step was supposed to do.
    expect(executed).toEqual([0, 1])
    expect(res.failed).toBe(1)
    expect(res.stoppedAt).toBe(1)
  })

  it('reports the failure with its reason, not a generic error', async () => {
    const { d } = driver({ 1: { ok: false, error: 'element is disabled' } })
    const res = await runPlan({ steps: [step('click'), step('click')] }, d)
    const failure = res.events.find((e): e is Extract<StepEvent, { type: 'failed' }> => e.type === 'failed')
    expect(failure?.reason).toBe('element is disabled')
    expect(failure?.index).toBe(1)
  })

  it('does not count a failed step toward the executed total', async () => {
    const { d } = driver({ 0: { ok: false, error: 'no such element' } })
    const res = await runPlan({ steps: [step('click'), step('click')] }, d)
    expect(res.executed).toBe(0)
  })
})

describe('confirmation is reachable', () => {
  it('asks the human when a step reports needsConfirm', async () => {
    const { d, asked } = driver({ 0: { ok: false, needsConfirm: true, reason: 'This submits the form.' } })
    const res = await runPlan({ steps: [step('click')] }, d)
    expect(asked).toEqual([0])
    expect(res.halted).toBe(1)
    expect(res.events.some((e) => e.type === 'confirmed')).toBe(true)
  })

  it('re-runs the held-back step once approved, and it can then succeed', async () => {
    let calls = 0
    const d: import('../lib/execution').StepDriver = {
      async run() {
        calls++
        // First dispatch is refused pending confirmation; the retry lands.
        return calls === 1
          ? { ok: false, needsConfirm: true, reason: 'submits the form', action: 'click', ms: 1 }
          : { ok: true, action: 'click', ms: 2 }
      },
      async ask() {
        return true
      },
    }
    const res = await runPlan({ steps: [step('click')] }, d)
    expect(calls).toBe(2)
    expect(res.executed).toBe(1)
    expect(res.failed).toBe(0)
  })

  it('stops the run when the user DECLINES, and records it as declined', async () => {
    const { d, executed } = driver({ 0: { ok: false, needsConfirm: true, reason: 'deletes everything' } }, [false])
    const res = await runPlan({ steps: [step('click'), step('click')] }, d)
    expect(res.events.some((e) => e.type === 'declined')).toBe(true)
    // Crucially: a decline is NOT a success, and NOT a failure of the page.
    expect(res.failed).toBe(0)
    expect(res.executed).toBe(0)
    expect(res.stoppedAt).toBe(0)
  })

  it('does not re-run a step the user declined', async () => {
    const { d, executed } = driver({ 0: { ok: false, needsConfirm: true, reason: 'pay' } }, [false])
    await runPlan({ steps: [step('click')] }, d)
    expect(executed).toEqual([0]) // dispatched once, never retried
  })

  it('treats an ask_user step as needing the human, not as a no-op', async () => {
    const { d, asked } = driver({}, [true])
    await runPlan({ steps: [step('ask_user', { reason: 'Which account?' })] }, d)
    expect(asked).toEqual([0])
  })
})

describe('loop control flow', () => {
  it('stops at a `none` step — the model declined, nothing after it matters', async () => {
    const { d, executed } = driver()
    const res = await runPlan({ steps: [step('click'), step('none'), step('click')] }, d)
    expect(executed).toEqual([0])
    expect(res.stoppedAt).toBe(1)
  })

  it('waits for wait_for without counting it as a performed step', async () => {
    const { d } = driver()
    const res = await runPlan({ steps: [step('wait_for', { amount: 10 }), step('click')] }, d)
    expect(res.executed).toBe(1)
    expect(res.events.some((e) => e.type === 'wait')).toBe(true)
  })

  it('an empty plan is a clean no-op, not an error', async () => {
    const { d, executed } = driver()
    const res = await runPlan({ steps: [] }, d)
    expect(executed).toEqual([])
    expect(res.stoppedAt).toBeNull()
  })

  it('caps runaway plans instead of clicking forever', async () => {
    const many = Array.from({ length: MAX_STEPS_PER_PLAN + 40 }, () => step('click'))
    const { d, executed } = driver()
    const res = await runPlan({ steps: many }, d)
    expect(executed.length).toBe(MAX_STEPS_PER_PLAN)
    expect(res.events.some((e) => e.type === 'capped')).toBe(true)
  })

  it('a step that is unknown still gets dispatched, not silently skipped', async () => {
    // An unrecognised action must not masquerade as success. It is reported
    // verbatim so the failure surfaces instead of hiding in a count.
    const { d, executed } = driver({ 0: { ok: false, error: 'unsupported action: teleport' } })
    const res = await runPlan({ steps: [step('teleport'), step('click')] }, d)
    expect(executed).toEqual([0])
    expect(res.failed).toBe(1)
  })
})

describe('the page settles between steps', () => {
  it('waits briefly after a step that changed something', async () => {
    // A click that re-renders asynchronously leaves the next step resolving
    // marks against a half-updated DOM. The loop, not the page, owns the wait.
    let waited = 0
    const d: import('../lib/execution').StepDriver = {
      async run() {
        return { ok: true, action: 'click', ms: 1, effect: 'confirmed' }
      },
      async ask() {
        return true
      },
    }
    await runPlan({ steps: [step('click'), step('click')] }, d, {
      settle: async (ms) => { waited += ms },
    })
    expect(waited).toBeGreaterThan(0)
  })

  it('does NOT settle after a step whose effect is unknown', async () => {
    // `unknown` means the page may not have reacted at all. Waiting for a
    // re-render that is not happening is pure latency.
    let waited = 0
    const d: import('../lib/execution').StepDriver = {
      async run() {
        return { ok: true, action: 'scroll', ms: 1, effect: 'unknown' }
      },
      async ask() { return true },
    }
    await runPlan({ steps: [step('scroll')] }, d, {
      settle: async (ms) => { waited += ms },
    })
    expect(waited).toBe(0)
  })

  it('does not settle after the final step — nothing follows it', async () => {
    let waited = 0
    const d: import('../lib/execution').StepDriver = {
      async run() { return { ok: true, action: 'click', ms: 1, effect: 'confirmed' } },
      async ask() { return true },
    }
    await runPlan({ steps: [step('click')] }, d, {
      settle: async (ms) => { waited += ms },
    })
    expect(waited).toBe(0)
  })

  it('a throwing settle must not fail the run', async () => {
    const d: import('../lib/execution').StepDriver = {
      async run() { return { ok: true, action: 'click', ms: 1, effect: 'confirmed' } },
      async ask() { return true },
    }
    const res = await runPlan({ steps: [step('click'), step('click')] }, d, {
      settle: async () => { throw new Error('tab closed') },
    })
    expect(res.executed).toBe(2)
    expect(res.ok).toBe(true)
  })
})

describe('an unverifiable action is not a failed action', () => {
  // Regression: mapping the effect straight onto `ok` made every
  // unverifiable action a failure, so a plan whose first step was `scroll`
  // aborted the whole run even though scrolling worked. "I cannot see whether
  // this worked" is a different statement from "this did not work", and only
  // the second one should stop a plan.
  const cases: Array<[string, import('../lib/execution').StepResult]> = [
    ['scroll', { ok: true, action: 'scroll', effect: 'unknown', ms: 1 }],
    ['navigate', { ok: true, action: 'navigate', effect: 'unknown', ms: 1 }],
    ['hover', { ok: true, action: 'hover', effect: 'unknown', ms: 1 }],
    ['focus', { ok: true, action: 'focus', effect: 'unknown', ms: 1 }],
  ]
  it.each(cases)('%s does not stop the run', async (_name, result) => {
    const executed: number[] = []
    const d: import('../lib/execution').StepDriver = {
      async run(i) {
        executed.push(i)
        return result
      },
      async ask() { return true },
    }
    const res = await runPlan({ steps: [step(_name), step('click')] }, d)
    expect(executed).toEqual([0, 1])
    expect(res.ok).toBe(true)
  })

  it('a verified-no-change DOES stop the run', async () => {
    // The distinction that matters: `unchanged` is evidence of failure,
    // `unknown` is absence of evidence.
    const d: import('../lib/execution').StepDriver = {
      async run() {
        return { ok: false, action: 'fill', effect: 'unchanged', error: 'the page did not change', ms: 1 }
      },
      async ask() { return true },
    }
    const res = await runPlan({ steps: [step('fill'), step('click')] }, d)
    expect(res.failed).toBe(1)
    expect(res.ok).toBe(false)
  })

  it('does not settle after an unverifiable step, but does after a verified one', async () => {
    const seen: string[] = []
    const d: import('../lib/execution').StepDriver = {
      async run(i) {
        return i === 0
          ? { ok: true, action: 'scroll', effect: 'unknown', ms: 1 }
          : { ok: true, action: 'click', effect: 'confirmed', ms: 1 }
      },
      async ask() { return true },
    }
    await runPlan({ steps: [step('scroll'), step('click'), step('click')] }, d, {
      settle: async () => { seen.push('settled') },
    })
    // Only the confirmed click, and only because another step followed it.
    expect(seen).toHaveLength(1)
  })
})

describe('every outcome is representable in the event log', () => {
  it('records a full successful run in order', async () => {
    const { d } = driver()
    const res: PlanRunResult = await runPlan(
      { steps: [step('click'), step('fill', { value: 'x' }), step('wait_for', { amount: 5 })] },
      d,
    )
    expect(res.events.map((e) => e.type)).toEqual(['executed', 'executed', 'wait'])
    expect(res.executed).toBe(2)
    expect(res.ok).toBe(true)
  })

  it('ok is false whenever anything went wrong', async () => {
    const { d } = driver({ 0: { ok: false, error: 'boom' } })
    const res = await runPlan({ steps: [step('click')] }, d)
    expect(res.ok).toBe(false)
  })
})
