/**
 * Two wiring defects that made the per-stage budgets dead in production.
 *
 * FOUND BY THE USER PASTING THIS TRACE
 * -------------------------------------
 *   [veil:sw] run ... start tier=T1 ... intent="What is on this page?"
 *   [veil:sw] run ... snapshot: 15 marks, 1 L0/L1 hits, opaque=0
 *   [veil:sw] capture+redact 2ms
 *   [veil:sw] snapshot 44ms
 *   [veil:sw] run ... stalled in "snapshot" after 45s
 *
 * Read the order. `capture+redact` completes BEFORE `snapshot 44ms` is
 * printed. A pipeline cannot finish stage 3 before stage 1 reports. So the two
 * stage() calls are executing in the opposite order to the work they describe.
 *
 * 1. THE STAGES ARE INTERLEAVED BECAUSE onSnapshotReady RUNS *INSIDE* THE AWAIT
 *
 *    startRun does:
 *        await toContent(tabId, {kind:'content:snapshot', runId})
 *        stage(runId, 'snapshot', now() - t0)      <-- (A)
 *
 *    and the content script answers by awaiting its own
 *    `chrome.runtime.sendMessage({kind:'snapshot:ready'})` before returning.
 *    So the ENTIRE onSnapshotReady handler — including
 *    `stage(run.runId, 'capture+redact', ...)` — executes before startRun
 *    reaches (A).
 *
 *    The result is that the last `stage()` call for a completed run is
 *    'snapshot', so the watchdog is left naming a stage that finished 44ms
 *    into a run that then spent 13-19s on the network. It reports the stall
 *    against 'snapshot' because 'snapshot' is genuinely the last thing the
 *    watchdog was told.
 *
 * 2. THE PER-STAGE TABLE WAS DEAD CODE IN PRODUCTION
 *
 *    `newWatchdog({ timeoutMs: DEFAULT_RUN_TIMEOUT_MS, ... })` in background.ts
 *    plus `this.opts.timeoutMs ?? stageTimeoutMs(stage)` in arm() means the
 *    flat override ALWAYS wins. Every stage got 45s, which is precisely the
 *    behaviour STAGE_TIMEOUT_MS was added to replace.
 *
 *    The table's own tests passed because they construct their own RunWatchdog
 *    without the override. Nothing tested the WIRING. This is the second time
 *    in this project a component was correct in isolation and inert in situ
 *    (the first was the DOM deadline, armed after the work it watched).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RunWatchdog, stageTimeoutMs, DEFAULT_RUN_TIMEOUT_MS } from '@/lib/watchdog'

describe('the production watchdog construction', () => {
  it('a flat override must WIN over the per-stage table', () => {
    // Documented behaviour: an explicit timeoutMs flattens every budget. This
    // is what made the table dead in production, so it stays a real behaviour
    // and is asserted here — a test that fails if someone "fixes" it silently.
    vi.useFakeTimers()
    const fired: string[] = []
    const wd = new RunWatchdog({
      timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
      onExpire: (r) => fired.push(r.stage),
    })
    wd.begin('run-1', 'send')
    // 'send' would normally get 60s, and 'snapshot' 8s. With the override both
    // get exactly 45s.
    vi.advanceTimersByTime(44_000)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect(fired).toEqual(['send'])
    vi.useRealTimers()
  })

  it('and the fix is that production must NOT pass one', () => {
    // This is the assertion that actually protects the fix. It reads
    // background.ts as text because the wiring is a constructor argument, and
    // a unit test on RunWatchdog cannot see it. Importing background.ts in a
    // test would need the whole chrome.* surface, so the source is the only
    // honest place to check this — and a source check is better than nothing,
    // because the failure mode is silent.
    //
    // The comment block that replaced the argument starts with "NO `timeoutMs`
    // HERE", so this must not regress back to a bare value.
    const src = readBackgroundSource()
    const ctor = src.slice(src.indexOf('const watchdog = newWatchdog('))
    const head = ctor.slice(0, ctor.indexOf('onExpire'))
    expect(head).not.toMatch(/timeoutMs\s*:/)
  })
})

describe('stage budgets are not flat when not overridden', () => {
  afterEach(() => vi.useRealTimers())

  it('uses the per-stage table', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const wd = new RunWatchdog({ onExpire: (r) => fired.push(r.stage) })

    wd.begin('run-1', 'snapshot')
    vi.advanceTimersByTime(stageTimeoutMs('snapshot') + 1)
    expect(fired).toEqual(['snapshot'])
  })
})

/** Read the built source. Kept in one place so the failure is legible. */
function readBackgroundSource(): string {
  // Vitest runs in node; the file is plain TS, so read it directly.
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { resolve } = require('node:path') as typeof import('node:path')
  return readFileSync(resolve(__dirname, '../entrypoints/background.ts'), 'utf8')
}

describe('a stage can only move forward', () => {
  afterEach(() => vi.useRealTimers())

  it('refuses a rewind and keeps the run at the stage it reached', () => {
    // The exact interleaving from the user's trace. onSnapshotReady runs inside
    // startRun's await, so 'capture+redact' is reported, and then 'snapshot'
    // arrives afterwards. Honouring that rewind is what made a healthy run
    // report a 45s "snapshot" stall.
    vi.useFakeTimers()
    const fired: string[] = []
    const rewinds: string[][] = []
    const wd = new RunWatchdog({
      onExpire: (r) => fired.push(r.stage),
      onRewind: (id, from, to) => rewinds.push([from, to]),
    })

    wd.begin('run-1', 'snapshot')
    wd.begin('run-1', 'capture+redact') // inside the await, fires first
    wd.begin('run-1', 'snapshot')        // startRun resumes, reports late

    expect(rewinds).toEqual([['capture+redact', 'snapshot']])
    // Still 'capture+redact', so a stall names the stage actually in progress.
    // Its budget is 15s (it was missing from the table and silently fell back
    // to 45s, which is what this test caught).
    vi.advanceTimersByTime(16_000)
    expect(fired).toEqual(['capture+redact'])
  })

  it('accepts a legitimate advance', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const wd = new RunWatchdog({ onExpire: (r) => fired.push(r.stage) })
    wd.begin('run-1', 'snapshot')
    wd.begin('run-1', 'send')
    vi.advanceTimersByTime(20_000)
    expect(fired).toEqual([])      // 'send' budget is 60s
    vi.advanceTimersByTime(45_000)
    expect(fired).toEqual(['send'])
  })
})
