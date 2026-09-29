/**
 * A run must be able to finish, report, and be seen doing it.
 *
 * THREE DEFECTS THESE EXIST FOR, all found by using the built extension rather
 * than by reading it:
 *
 * 1. SILENT ORPHANING. `runs` is a plain Map in the service worker, and MV3
 *    terminates an idle worker after ~30s. A T1 turn measures p50 ~13s and
 *    p95 ~19s, and the full pipeline routinely exceeds 30s — so the worker
 *    dies mid-run, the run is lost, and NONE of the four terminal messages
 *    (panel:plan / panel:answer / panel:error / redact:aborted) is ever sent.
 *    The panel's `busy` flag is only cleared by those four, so it spins
 *    forever with no error. That is the "it starts and never stops" report.
 *
 * 2. NO LOGS. 282 of the project's console.* calls are in bench scripts. The
 *    runtime files logged essentially nothing, so the service-worker console
 *    was empty even mid-failure — and because the worker dies, console output
 *    is lost anyway. The log has to be PERSISTED and shown in the panel.
 *
 * 3. A DEAD RELOAD BUTTON. reloadVeil() sent `panel:run` directly instead of
 *    going through runIntent(), so it never set `busy`, never pushed a
 *    transcript line, and produced no visible feedback at all.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RunWatchdog, newWatchdog, describeRunError, isTerminalStage } from '@/lib/watchdog'
// RING_BUFFER_MAX lives in logging, not watchdog. Importing it from the wrong
// module silently yields undefined, and `undefined + 40` is NaN, so the ring
// loop pushes NOTHING and the test fails with an empty array. tsc did not
// catch it because the wrong module is a valid module that simply lacks the
// export at runtime.
import { LogRing, createLogger, LOG_CHANNELS, RING_BUFFER_MAX } from '@/lib/logging'

describe('watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires when a run outlives its budget and reports WHY it stopped', () => {
    const onExpire = vi.fn()
    const wd = newWatchdog({ timeoutMs: 30_000, onExpire })
    wd.begin('run-1', 'snapshot')

    vi.advanceTimersByTime(29_000)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_500)
    // The message must name the stage, or the user is told only "it stopped",
    // which is the same information they already had.
    expect(onExpire).toHaveBeenCalledTimes(1)
    const payload = onExpire.mock.calls[0]![0]
    expect(payload.runId).toBe('run-1')
    expect(payload.stage).toBe('snapshot')
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(30_000)
  })

  it('does NOT fire for a run that reaches a terminal stage in time', () => {
    const onExpire = vi.fn()
    const wd = newWatchdog({ timeoutMs: 30_000, onExpire })
    wd.begin('run-1', 'send')
    vi.advanceTimersByTime(5_000)
    wd.finish('run-1')
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('is not reset by a duplicate begin for the SAME stage', () => {
    const onExpire = vi.fn()
    // No flat override: this is testing the real per-stage table. 'send' gets
    // 60s, so the assertions below are relative to that.
    const wd = newWatchdog({ onExpire })
    wd.begin('run-1', 'send')
    // The SW can receive a repeated stage message for the stage a run is
    // already in. Restarting the clock on each one would let a stalled run
    // live forever, which is the bug.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(5_000)
      wd.begin('run-1', 'send')
    }
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30_000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('times out a run that is orphaned by a worker restart', () => {
    // The restart case: the in-memory run is gone, so nothing calls finish().
    // A fresh worker has no run at all, so the ORPHAN detector is what has to
    // catch it — a run the panel still believes is in flight.
    const onExpire = vi.fn()
    const wd = newWatchdog({ timeoutMs: 45_000, onExpire })
    wd.begin('run-1', 'send')
    vi.advanceTimersByTime(45_001)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire.mock.calls[0]![0].stage).toBe('send')
  })

  it('exposes whether a stage is terminal', () => {
    expect(isTerminalStage('done')).toBe(true)
    expect(isTerminalStage('aborted')).toBe(true)
    expect(isTerminalStage('execute')).toBe(false)
    expect(isTerminalStage('send')).toBe(false)
  })
})

describe('describeRunError', () => {
  it('names the stage rather than saying only "it stopped"', () => {
    const msg = describeRunError({ runId: 'r', stage: 'send', elapsedMs: 31_000 })
    // The internal id is 'send'; the user must read something that names what
    // that means. Asserting on 'send' would pass for a message that dumped the
    // raw enum, which is not what anyone should have to read.
    expect(msg).toMatch(/contacting the model/i)
    expect(msg).toMatch(/31s|30s|31\.0s/)
    expect(msg).not.toMatch(/^Something went wrong/)
    expect(msg).not.toMatch(/^undefined/)
  })

  it('explains a service-worker restart specifically, because that is the usual cause', () => {
    const msg = describeRunError({ runId: 'r', stage: 'redact', elapsedMs: 40_000 })
    // The single most common cause is the worker being recycled mid-run; the
    // user needs to know their data did NOT go anywhere, and what to do.
    expect(msg.length).toBeGreaterThan(20)
  })
})

describe('log ring', () => {
  it('keeps the newest entries and drops the oldest past the cap', () => {
    const ring = newLogRingForTest()
    const total = RING_BUFFER_MAX + 40
    for (let i = 0; i < total; i++) ring.push('sw', `line ${i}`, 'info')
    const all = ring.all()
    expect(all.length).toBe(RING_BUFFER_MAX)
    // The most recent line must survive; the oldest must be gone. Spelled from
    // `total` rather than from the constant, because the two off-by-N ways to
    // write this are indistinguishable until one of them fails.
    expect(all[all.length - 1]?.text).toBe(`line ${total - 1}`)
    expect(all[0]?.text).toBe(`line ${total - RING_BUFFER_MAX}`)
    expect(all.some((e) => e.text === 'line 0')).toBe(false)
  })

  it('never stores a secret, because a log is a place secrets leak', () => {
    const ring = newLogRingForTest()
    ring.push('sw', 'Authorization: Bearer sk-abcdef123456', 'info')
    ring.push('sw', 'api_key=supersecret', 'info')
    const text = ring.all().map((e) => e.text).join(' ')
    expect(text).not.toMatch(/sk-abcdef123456/)
    expect(text).not.toMatch(/supersecret/)
  })

  it('keeps the original entry readable enough to be useful', () => {
    const ring = newLogRingForTest()
    ring.push('content', 'snapshot ready, 52 marks', 'info')
    const e = ring.all()[0]!
    expect(e.channel).toBe('content')
    expect(e.level).toBe('info')
    expect(e.text).toContain('52 marks')
    expect(typeof e.t).toBe('number')
  })

  it('re-redacts a value that is scrubbed only at read time', () => {
    const ring = newLogRingForTest()
    ring.push('sw', 'provider=Bearer sk-live-9f8e7d6c', 'info')
    const joined = ring.allForDisplay().map((e) => e.text).join(' ')
    expect(joined).not.toMatch(/sk-live-9f8e7d6c/)
  })
})

describe('logger', () => {
  it('routes each channel to the console AND the ring', () => {
    const ring = newLogRingForTest()
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const log = createLogger(ring)
    for (const ch of LOG_CHANNELS) log(ch, 'hello', 'info')
    spy.mockRestore()
    expect(ring.all().length).toBe(LOG_CHANNELS.length)
    expect(ring.all().map((e) => e.channel)).toEqual([...LOG_CHANNELS])
  })

  it('mirrors warn and error to the matching console level', () => {
    const ring = newLogRingForTest()
    const w = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = createLogger(ring)
    log('sw', 'careful', 'warn')
    log('sw', 'broken', 'error')
    // Assert BEFORE restoring: mockRestore() detaches the spy, and asserting
    // afterwards is how a test ends up passing against a mock nothing called.
    expect(w).toHaveBeenCalled()
    expect(e).toHaveBeenCalled()
    w.mockRestore()
    e.mockRestore()
  })
})

// ---------------------------------------------------------------------
function newLogRingForTest(): LogRing {
  return new LogRing()
}
