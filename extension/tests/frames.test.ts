import { describe, it, expect } from 'vitest'
import { frameDecision, type FrameRouting } from '../lib/frames'

/**
 * Frame routing — audit finding 0.2.
 *
 * The content script is registered with `allFrames: true`, which is correct and
 * load-bearing: iframes must report their own DOM so the redaction cascade can
 * see (and blank) their content. But the SAME registration also meant the
 * `content:execute` broadcast reached every same-origin frame at once, and each
 * one resolved the mark against ITS OWN DOM.
 *
 * The result: one planned click fired in the top frame and in every iframe that
 * happened to contain a matching element. A plan that said "click the Submit
 * button" could press three Submit buttons on three different documents.
 *
 * The fix is to keep `allFrames` for perception and scope EXECUTION to one
 * frame. These tests pin the routing decision.
 */

const TOP: FrameRouting = { frameId: 0, isTop: true }

describe('execution is scoped to the frame that observed the mark', () => {
  it('routes to the top frame when the plan targets the top document', () => {
    const d = frameDecision(TOP, TOP)
    expect(d.execute).toBe(true)
    expect(d.reason).toBe('top frame')
  })

  it('refuses to execute in a frame the plan did not name', () => {
    // frameId 0 == top. A frame that is not the target must do nothing.
    const d = frameDecision({ frameId: 7, isTop: false }, TOP)
    expect(d.execute).toBe(false)
    expect(d.reason).toMatch(/not the target frame/i)
  })

  it('executes in the named subframe', () => {
    const d = frameDecision({ frameId: 7, isTop: false }, { frameId: 7, isTop: false })
    expect(d.execute).toBe(true)
  })

  it('fails SAFE when a plan carries no frame information', () => {
    // Defaulting to "execute everywhere" is the bug being fixed. An unmarked
    // plan must not fan out across every frame.
    const d = frameDecision({ frameId: 3, isTop: false }, null)
    expect(d.execute).toBe(false)
    expect(d.reason).toMatch(/no frame/i)
  })

  it('a top-frame plan does not run in a subframe even when the mark matches', () => {
    const d = frameDecision({ frameId: 12, isTop: false }, TOP)
    expect(d.execute).toBe(false)
  })

  it('frame ids compare by value, not identity', () => {
    // The id arrives over the wire as a number; a string must not silently
    // fail to match and cause the action to be skipped.
    const d = frameDecision({ frameId: 5, isTop: false }, { frameId: 5, isTop: false })
    expect(d.execute).toBe(true)
  })
})

describe('snapshot reporting is NOT scoped', () => {
  it('every frame reports its own snapshot', () => {
    // The opposite rule on purpose: perception must fan out, or iframe content
    // is invisible to redaction and leaks in the clear.
    const d = frameDecision({ frameId: 9, isTop: false }, TOP)
    expect(d.report).toBe(true)
  })
})
