import { describe, it, expect } from 'vitest'
import { decideSafety, DESTRUCTIVE_ACTIONS } from '../lib/action-safety'
/**
 * The action-safety policy — audit finding 5.3, the reroll-into-sensitive-field
 * hole, plus the coverage gap that let it through.
 *
 * A mark is an index into a snapshot. When the page re-renders between the plan
 * and the click, `resolveMark` can return a DIFFERENT node. Nothing re-checked
 * what that node was, so "click mark 17" could become a click on the Aadhaar
 * field. The sensitive-target guard existed but lived INSIDE the `fill` case —
 * `click`, `focus` and `select` had none at all.
 */
describe('destructive actions always require a human click', () => {
  it.each([...DESTRUCTIVE_ACTIONS])('%s is gated regardless of target', (action) => {
    const v = decideSafety({ action })
    expect(v.confirm).toBe(true)
    expect(v.rule).toBe('destructive_action')
  })

  it('gates on the control text too, not only the action name', () => {
    // "click" onto a button labelled "Place order" is a purchase.
    const v = decideSafety({ action: 'click', verb: 'Place order' })
    expect(v.confirm).toBe(true)
    expect(v.rule).toBe('destructive_verb')
  })

  it.each(['Place order', 'Confirm order', 'Transfer funds', 'Delete account', 'Withdraw'])(
    'gates the verb %s',
    (verb) => {
      expect(decideSafety({ action: 'click', verb }).confirm).toBe(true)
    },
  )
})

describe('the reroll hole [audit 5.3]', () => {
  it('blocks a click that lands on a sensitive node after a re-render', () => {
    // The exact failure: mark 17 was a harmless button at plan time; after the
    // re-render it resolved to the Aadhaar input.
    const v = decideSafety({ action: 'click', rerolled: true, targetSensitive: true })
    expect(v.confirm).toBe(true)
    expect(v.rule).toBe('reroll_into_sensitive')
    expect(v.reason).toMatch(/moved/i)
  })

  it.each(['click', 'focus', 'select', 'hover'])(
    'gates %s — not just fill, which was the only guarded one',
    (action) => {
      expect(
        decideSafety({ action, rerolled: true, targetSensitive: true }).confirm,
        action,
      ).toBe(true)
    },
  )

  it('does not gate when the node did NOT move', () => {
    // The whole point is the reroll. A sensitive field the model deliberately
    // targeted, still in place, needs no extra prompt beyond the fill guard.
    const v = decideSafety({ action: 'focus', rerolled: false, targetSensitive: true })
    expect(v.confirm).toBe(false)
  })

  it('does not gate a reroll onto an ordinary control', () => {
    // Otherwise every re-render would interrupt the user.
    const v = decideSafety({ action: 'click', rerolled: true, targetSensitive: false })
    expect(v.confirm).toBe(false)
    expect(v.rule).toBe('none')
  })
})

describe('filling a sensitive field', () => {
  it('always asks, on a stable target', () => {
    const v = decideSafety({ action: 'fill', targetSensitive: true })
    expect(v.confirm).toBe(true)
    expect(v.rule).toBe('fill_into_sensitive')
  })

  it('does not ask when the field is ordinary', () => {
    expect(decideSafety({ action: 'fill', targetSensitive: false }).confirm).toBe(false)
  })
})

describe('non-acting actions never prompt', () => {
  it.each(['none', 'ask_user', 'wait_for'])('%s proceeds without a dialog', (action) => {
    // Including on a rerolled sensitive target: `none` does not touch the
    // page, so prompting would be a false alarm the user learns to dismiss.
    const v = decideSafety({ action, rerolled: true, targetSensitive: true })
    expect(v.confirm).toBe(false)
    expect(v.rule).toBe('none')
  })
})

describe('every gated verdict carries a user-facing reason', () => {
  it('never returns confirm:true with a null reason', () => {
    // A confirm dialog with nothing to say trains the user to click through it.
    const cases = [
      { action: 'submit' },
      { action: 'click', verb: 'Delete account' },
      { action: 'fill', targetSensitive: true },
      { action: 'click', rerolled: true, targetSensitive: true },
    ]
    for (const c of cases) {
      const v = decideSafety(c)
      if (v.confirm) {
        expect(v.reason, JSON.stringify(c)).toBeTruthy()
        expect(v.reason!.length).toBeGreaterThan(10)
      }
    }
  })
})
