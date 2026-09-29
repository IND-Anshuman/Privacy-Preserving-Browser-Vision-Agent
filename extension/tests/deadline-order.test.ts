/**
 * A stage deadline must be armed BEFORE the work, and must be settleable by an
 * event that arrives first.
 *
 * THE DEFECT THIS WAS FOUND BY
 * ----------------------------
 * A user ran the built extension and pasted the panel:
 *
 *   server unreachable (timeout)
 *   What is on this page?
 *   Stopped
 *   Veil read the page for 8s and got nothing back, so it stopped. The page may
 *   be very large, or a script on it may be blocking the page's own handlers.
 *
 * The page had already been read successfully — the previous run logged
 * `snapshot: 15 marks` in 37ms. So the 8s DOM deadline was not reporting a
 * slow page. It was firing on a healthy run.
 *
 * WHY, PRECISELY: the content script handles `content:snapshot` by AWAITING its
 * own `chrome.runtime.sendMessage({kind:'snapshot:ready'})` and only then
 * returning `{ok:true}`. Both happen inside one message turn. So by the time
 * `await toContent(...)` resolves in startRun:
 *
 *   1. `snapshot:ready` has ALREADY been handled, and its handler called
 *      `clearStageDeadline()` — against a timer that had not been armed yet, so
 *      that call settled nothing.
 *   2. THEN startRun armed the 8s deadline.
 *
 * The deadline was armed after the only event it watched for, with nothing left
 * to clear it. Guaranteed to fire, 8s later, on a run that had already moved to
 * the network turn.
 *
 * This is why `end()` has to settle a run even when nothing is armed, and why
 * `begin()` is called before the await rather than after it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { StageDeadline } from '@/lib/watchdog'

describe('StageDeadline', () => {
  afterEach(() => vi.useRealTimers())

  it('fires when the stage it watches never completes', () => {
    vi.useFakeTimers()
    const d = new StageDeadline()
    const fired: string[] = []
    d.begin('run-1', 'snapshot', 8_000, (s) => fired.push(s))

    vi.advanceTimersByTime(8_001)
    expect(fired).toEqual(['snapshot'])
  })

  it('is cancelled by the event it was watching for', () => {
    vi.useFakeTimers()
    const d = new StageDeadline()
    const fired: string[] = []
    d.begin('run-1', 'snapshot', 8_000, (s) => fired.push(s))
    d.end('run-1') // onSnapshotReady

    vi.advanceTimersByTime(60_000)
    expect(fired).toEqual([])
  })

  it('THE BUG: an end() that ran BEFORE begin() must still settle the run', () => {
    // This is the exact sequence a real run produces. The content script sends
    // `snapshot:ready` and then returns, so the event is handled before
    // startRun reaches the arming line.
    vi.useFakeTimers()
    const d = new StageDeadline()
    const fired: string[] = []

    d.end('run-1') // the event, handled during the await
    d.begin('run-1', 'snapshot', 8_000, (s) => fired.push(s)) // armed after

    vi.advanceTimersByTime(60_000)
    // The correct behaviour: begin() REFUSES, because this run is settled, so
    // the deadline can never fire on a run that has already moved past it.
    expect(fired).toEqual([])
  })

  it('refuses to arm for an already-settled run', () => {
    const d = new StageDeadline()
    d.end('run-1')
    expect(d.begin('run-1', 'snapshot', 8_000, () => {})).toBe(false)
  })

  it('arms normally for a run that is still in flight', () => {
    const d = new StageDeadline()
    expect(d.begin('run-1', 'snapshot', 8_000, () => {})).toBe(true)
    expect(d.armed).toBe('run-1:snapshot')
  })

  it('forget() re-admits a run id, so a reused id is not silently dead', () => {
    // The panel generates ids, so a collision is unlikely — but a deadline
    // that can never arm again after a collision would be a silent hang, which
    // is the exact failure mode this file exists to prevent.
    const d = new StageDeadline()
    d.end('run-1')
    expect(d.begin('run-1', 'snapshot', 8_000, () => {})).toBe(false)
    d.forget('run-1')
    expect(d.begin('run-1', 'snapshot', 8_000, () => {})).toBe(true)
  })
})
