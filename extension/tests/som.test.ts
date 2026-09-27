import { describe, it, expect } from 'vitest'
import {
  assignMarks,
  resolveMark,
  labelSimilarity,
  badgeRect,
  isInteractive,
  readingOrder,
  type MarkCandidate,
} from '../lib/som'

const cand = (nodeId: string, role: string, label: string, x: number, y: number, w = 80, h = 30, eligible = true): MarkCandidate => ({
  nodeId,
  role,
  label,
  box: { x, y, w, h },
  actions: [role === 'button' ? 'click' : 'fill'],
  eligible,
})

describe('mark assignment', () => {
  it('numbers marks from 1 in reading order', () => {
    const a = assignMarks([
      cand('a', 'button', 'Bottom', 10, 500),
      cand('b', 'button', 'Top', 10, 10),
      cand('c', 'link', 'Middle', 10, 250),
    ])
    expect(a.map((x) => x.mark)).toEqual([1, 2, 3])
    expect(a.map((x) => x.label)).toEqual(['Top', 'Middle', 'Bottom'])
  })

  it('reads a row left-to-right', () => {
    const a = assignMarks([
      cand('right', 'button', 'Continue', 300, 100),
      cand('left', 'button', 'Back', 20, 100),
    ])
    expect(a[0]!.label).toBe('Back')
    expect(a[1]!.label).toBe('Continue')
  })

  it('skips ineligible and non-interactive nodes', () => {
    const a = assignMarks([
      cand('x', 'button', 'Hidden', 0, 0, 80, 30, false),
      cand('y', 'heading', 'A heading', 0, 10),
      cand('z', 'button', 'Visible', 0, 20),
    ])
    expect(a).toHaveLength(1)
    expect(a[0]!.label).toBe('Visible')
  })

  it('is deterministic', () => {
    const cands = [cand('a', 'button', 'A', 0, 0), cand('b', 'textbox', 'B', 100, 0), cand('c', 'link', 'C', 200, 5)]
    expect(assignMarks(cands)).toEqual(assignMarks([...cands].reverse()))
  })

  it('prioritises primary buttons over links', () => {
    const a = assignMarks([cand('l', 'link', 'Terms', 0, 0, 20, 20), cand('b', 'button', 'Submit', 300, 300, 200, 60)])
    const btn = a.find((x) => x.nodeId === 'b')!
    const link = a.find((x) => x.nodeId === 'l')!
    expect(btn.priority).toBeGreaterThan(link.priority)
  })
})

describe('label similarity', () => {
  it('is 1 for identical labels ignoring case and punctuation', () => {
    expect(labelSimilarity('Submit form!', 'submit form')).toBe(1)
  })
  it('is 0 for disjoint labels', () => {
    expect(labelSimilarity('Submit', 'Cancel')).toBe(0)
  })
  it('is partial for overlapping labels', () => {
    const s = labelSimilarity('Next step', 'Next')
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
  })
})

describe('mark re-resolution at execution time', () => {
  const marks = assignMarks([cand('n1', 'button', 'Continue', 0, 0), cand('n2', 'textbox', 'Full name', 0, 100)])

  it('resolves an unchanged page exactly', () => {
    const r = resolveMark(1, marks, [cand('n1', 'button', 'Continue', 0, 0), cand('n2', 'textbox', 'Full name', 0, 100)])
    expect(r.status).toBe('ok')
    expect(r.nodeId).toBe('n1')
    expect(r.confidence).toBe(1)
  })

  it('survives a re-render that replaced the node identity but kept the label', () => {
    const r = resolveMark(1, marks, [cand('x99', 'button', 'Continue', 5, 5), cand('n2', 'textbox', 'Full name', 0, 100)])
    expect(r.status).toBe('reassigned')
    expect(r.nodeId).toBe('x99')
    expect(r.confidence).toBeGreaterThan(0.5)
  })

  it('never blindly clicks: a vanished target returns lost', () => {
    const r = resolveMark(1, marks, [cand('n2', 'textbox', 'Full name', 0, 100)])
    expect(r.status).toBe('lost')
    expect(r.nodeId).toBe('')
  })

  it('returns lost for an out-of-range mark with no plausible candidate', () => {
    const r = resolveMark(99, marks, [cand('n2', 'textbox', 'Full name', 0, 100)])
    expect(r.status).toBe('lost')
  })

  it('rejects a same-node relabel into a different control', () => {
    const m = assignMarks([cand('n1', 'button', 'Continue', 0, 0)])
    const r = resolveMark(1, m, [cand('n1', 'button', 'Delete account permanently', 0, 0)])
    expect(r.status).toBe('lost')
  })
})

describe('badges and roles', () => {
  it('pins a badge just outside the top-left corner', () => {
    const r = badgeRect({ x: 100, y: 200, w: 60, h: 20 }, 1.5)
    expect(r.x).toBeLessThan(100)
    expect(r.y).toBeLessThan(200)
    expect(r.w).toBe(22 * 1.5)
  })

  it('clamps badges at the viewport origin', () => {
    const r = badgeRect({ x: 0, y: 0, w: 60, h: 20 }, 1)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
  })

  it('knows which roles are interactive', () => {
    expect(isInteractive('button')).toBe(true)
    expect(isInteractive('textbox')).toBe(true)
    expect(isInteractive('heading')).toBe(false)
    expect(isInteractive('span')).toBe(false)
  })

  it('groups rows before sorting so a two-column layout does not interleave', () => {
    const cands = [
      cand('a1', 'link', 'L1', 10, 10),
      cand('a2', 'link', 'L2', 10, 40),
      cand('a3', 'link', 'L3', 10, 70),
      cand('b1', 'link', 'R1', 300, 10),
    ]
    const order = readingOrder(cands).map((c) => c.label)
    expect(order.slice(0, 2).sort()).toEqual(['L1', 'R1'])
  })
})
