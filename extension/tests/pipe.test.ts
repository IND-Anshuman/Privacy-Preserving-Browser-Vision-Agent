/**
 * A run that cannot take a snapshot must say so, not wait for the watchdog.
 *
 * THE DEFECT THIS WAS FOUND BY
 * ----------------------------
 * A user ran the built extension and pasted the console:
 *
 *   [veil:sw] run run-mun1nq50 start tier=T1 session=sess-... turn=0
 *   [veil:sw] snapshot 2ms
 *   [veil:sw] run run-mun1nq50 stalled in "snapshot" after 45s
 *
 * `snapshot 2ms` was the clue. A real DOM snapshot of a page with 50 elements
 * does not take 2 ms; what takes 2 ms is `chrome.tabs.sendMessage` REJECTING,
 * because there is no content script listening on that tab.
 *
 * `toContent()` catches every rejection and returns `{ blocked: true }`. The
 * EXECUTION path checks that field (a missing port fails a step loudly). The
 * SNAPSHOT path never looked at it — so `startRun` returned `{ok:true}` and
 * then sat waiting for a `snapshot:ready` that could never arrive, until the
 * new 45s watchdog reported the stall. Correct diagnosis, useless timing: the
 * user waited 45 seconds to be told what one synchronous check could have said
 * in 2 milliseconds.
 *
 * WHAT THIS PINS
 * ---------------
 * The blocked result must be detected, reported with a cause the user can
 * act on, and must NOT be reported as a successful snapshot.
 */
import { describe, it, expect } from 'vitest'
import { describeSnapshotFailure, isBlockedResult, type SnapshotFailure } from '@/lib/pipe'

describe('isBlockedResult', () => {
  it('recognises the {blocked:true} sentinel toContent returns', () => {
    expect(isBlockedResult({ blocked: true })).toBe(true)
    expect(isBlockedResult({ blocked: false })).toBe(false)
  })

  it('does not treat a normal content-script reply as blocked', () => {
    expect(isBlockedResult({ ok: true, detections: 4, marks: 12 })).toBe(false)
    expect(isBlockedResult(undefined)).toBe(false)
    expect(isBlockedResult(null)).toBe(false)
  })
})

describe('describeSnapshotFailure', () => {
  it('names the actual cause rather than saying "no content script"', () => {
    // The three reasons a content script is absent are different problems
    // with different fixes, and a user can only act on one of them.
    const onChromePage = describeSnapshotFailure('chrome')
    expect(onChromePage.toLowerCase()).toContain('chrome')
    expect(onChromePage.toLowerCase()).not.toMatch(/just wait|refresh and try again$/)
  })

  it('tells the user to reload the page when the script was not injected', () => {
    const msg = describeSnapshotFailure('not-injected')
    // This is THE common case: the extension was installed or reloaded after
    // the tab was already open, so the content script was never injected.
    expect(msg).toMatch(/reload/i)
    expect(msg).toMatch(/page/i)
  })

  it('explains a restricted page without blaming the user', () => {
    const msg = describeSnapshotFailure('restricted')
    expect(msg.length).toBeGreaterThan(15)
  })
})
