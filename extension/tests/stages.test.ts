/**
 * The run watchdog must cover EVERY stage, including the slow one.
 *
 * THE DEFECT THIS WAS FOUND BY
 * -----------------------------
 * A user ran the built extension and pasted the console:
 *
 *   [veil:sw] run run-mun2cx4x start tier=T1 ... intent="What is on this page?"
 *   [veil:sw] snapshot: 15 marks, 1 L0/L1 hits, opaque=0
 *   [veil:sw] capture+redact 2ms
 *   [veil:sw] snapshot 37ms
 *   [veil:sw] run run-mun2cx4x stalled in "snapshot" after 45s
 *
 * Read the order. The stage was reported as "snapshot" AFTER capture+redact
 * had already completed. And "snapshot 37ms" is the run's own timing line —
 * so the snapshot genuinely finished in 37ms.
 *
 * The reason the stall says "snapshot" is that NOTHING EVER ADVANCED THE
 * STAGE PAST IT. The two stage transitions in the whole pipeline are:
 *
 *   stage(runId, 'snapshot', ...)   -- inside startRun
 *   stage(runId, 'execute', ...)    -- after the plan comes back
 *
 * There is no stage for capture, redact, or the network turn. The T1 path sets
 * `run.stage = 'send'` as a RAW ASSIGNMENT, not through `stage()`. And
 * `stage()` is what calls `watchdog.begin()`. So the watchdog was still
 * holding the timer armed for "snapshot" — 45 seconds, counted from the
 * snapshot — and the ~13-19 second network turn was happening INSIDE that
 * window with nothing re-arming it.
 *
 * Two separate bugs fell out of that:
 *
 *   1. `armStageDeadline(runId, 'snapshot', 8s)` fires at 8s and aborts a run
 *      that is perfectly healthy and simply waiting on the network. That
 *      deadline was added for the DOM channel, but it was never DISARMED when
 *      the snapshot landed — only `clearStageDeadline` on `snapshot:ready` was
 *      missing... except `onSnapshotReady` DOES call it. So the 8s deadline
 *      was fine. The 45s watchdog is what misfired, and it misfired by
 *      reporting the WRONG STAGE NAME, which sent the user chasing MV3
 *      worker-recycling — a completely different problem.
 *
 *   2. The network turn gets no watchdog of its own, so a genuinely hung
 *      request is only caught 45s after the SNAPSHOT, not 45s after the
 *      request started.
 *
 * The fix is to make `stage()` the only way a stage changes, so that every
 * transition re-arms the watchdog with a deadline appropriate to the new
 * stage. The whole class of bug dies when a raw `run.stage = 'x'` cannot
 * exist next to a `stage(runId, 'x', ...)` call.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RunWatchdog, STAGE_TIMEOUT_MS, stageTimeoutMs } from '@/lib/watchdog'

describe('stage budgets cover the whole pipeline', () => {
  it('has a budget for every stage the run actually passes through', () => {
    // These are the stages the pipeline visits. If one is missing it silently
    // falls back to the 45s default — which is how the network turn ended up
    // unmonitored.
    for (const s of ['snapshot', 'capture', 'redact', 'send', 'execute']) {
      expect(STAGE_TIMEOUT_MS[s], `no budget for ${s}`).toBeGreaterThan(0)
    }
  })

  it('gives the network turn far more than the local page walk', () => {
    // The measured p95 for a remote T1 turn is ~19s. A budget at or below the
    // local-walk budget would abort healthy runs; the point of the table is
    // that each stage is budgeted against what it actually does.
    expect(stageTimeoutMs('send')).toBeGreaterThan(stageTimeoutMs('snapshot') * 4)
  })

  it('never budgets below what was measured', () => {
    // 19s p95 plus headroom. Anything under this aborts real requests.
    expect(stageTimeoutMs('send')).toBeGreaterThanOrEqual(25_000)
  })
})

describe('a run that advances re-arms the watchdog', () => {
  afterEach(() => vi.useRealTimers())

  it('gives the network turn its own budget instead of the snapshot\'s', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const wd = new RunWatchdog({ onExpire: (r) => fired.push(r.stage) })

    // A real run spends ~37ms in the snapshot (measured) before advancing, so
    // walk the local stages quickly, then arrive at the network turn.
    wd.begin('run-1', 'snapshot')
    vi.advanceTimersByTime(37)
    wd.begin('run-1', 'send')

    // The snapshot budget is 8s, so WITHOUT re-arming this would have fired
    // 8s after the snapshot began. It must not.
    vi.advanceTimersByTime(20_000)
    expect(fired).toEqual([])

    // 'send' gets 60s from ITS start.
    vi.advanceTimersByTime(45_000)
    expect(fired).toEqual(['send'])
  })

  it('does not re-arm on a repeat message for the same stage', () => {
    // Otherwise a wedged run that keeps emitting holds the panel hostage.
    vi.useFakeTimers()
    const fired: string[] = []
    const wd = new RunWatchdog({ onExpire: (r) => fired.push(r.stage) })
    wd.begin('run-1', 'send')
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(5_000)
      wd.begin('run-1', 'send')
    }
    expect(fired).toEqual([])          // 50s in, budget is 60s
    vi.advanceTimersByTime(15_000)     // 65s in
    expect(fired).toEqual(['send'])
  })
})
