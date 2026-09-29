/**
 * Post-action verification — audit finding 1.3.
 *
 * The single most important idea in this file: **dispatching an event is not
 * evidence that anything happened.** A click notifies listeners; it does not
 * promise the page changed. So every function here starts from `unknown` and
 * has to be talked up to `confirmed` by positive, checkable evidence.
 *
 * Consequences that fall out of that, all of them deliberate:
 *
 *  - A disabled or hidden control can never be `confirmed`, even if something
 *    claims it responded. A click on a disabled button is the canonical silent
 *    failure.
 *  - Password fields are never asserted on by value, because confirming a
 *    password fill would mean comparing secrets.
 *  - `scroll` / `navigate` / `focus` / `hover` are always `unknown`. Their
 *    effects are either off-screen, in another document, or genuinely
 *    unobservable from a content script.
 *  - A throwing or absent probe degrades to `unknown` rather than failing the
 *    run, but it also never upgrades to `confirmed`.
 *
 * `unknown` is a first-class, honest answer. It is NOT a failure and NOT a
 * success, and the run loop treats it accordingly.
 */

export type Effect = 'confirmed' | 'changed' | 'unchanged' | 'unknown'

export interface EffectObservation {
  /** Free-form observation of what the page did. All fields optional. */
  responded?: boolean
  /** Text/value the action was supposed to produce. */
  value?: string
  navigated?: boolean
  changed?: boolean
}

export interface VerifyInput {
  /** The value the action asked for, for value-shaped actions. */
  expected?: string
  /** A caller-supplied observation of page response. */
  probe?: () => EffectObservation | null
}

const UNKNOWN: Effect = 'unknown'

/** A control that cannot be operated on, whatever the probe claims. */
function isInert(el: Element | null): boolean {
  if (!el) return true
  const anyEl = el as HTMLElement & { disabled?: boolean }
  if (anyEl.disabled) return true
  if (el.getAttribute('aria-disabled') === 'true') return true
  if (el.hasAttribute('inert')) return true
  // jsdom has no layout, so only trust a *declared* hidden state here. The
  // content script's own isVisible() handles real geometry.
  if (el.getAttribute('hidden') !== null) return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  const style = el.getAttribute('style') ?? ''
  if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return true
  return false
}

/**
 * Tag-based checks, deliberately NOT `instanceof`.
 *
 * Two reasons, both real:
 *  - `instanceof HTMLSelectElement` throws a ReferenceError wherever the
 *    constructor is not a global (a plain Node/jsdom context, a worker), so
 *    the verifier could not be unit tested at all.
 *  - `instanceof` is realm-bound. An element belonging to a same-origin iframe
 *    comes from a different realm, so `el instanceof HTMLSelectElement` is
 *    FALSE for a real `<select>` inside a frame — a cross-frame select would
 *    silently verify as `unknown`. `tagName` is realm-independent.
 */
function tagOf(el: Element): string {
  return el.tagName.toLowerCase()
}

function isPassword(el: Element | null): boolean {
  if (!el || tagOf(el) !== 'input') return false
  return (el as HTMLInputElement).type === 'password'
}

function safeProbe(input: VerifyInput): EffectObservation | null {
  if (!input.probe) return null
  try {
    return input.probe()
  } catch {
    // A detached node or a torn-down frame. Unknown, never confirmed.
    return null
  }
}

export function verifyEffect(
  action: string,
  el: Element | null,
  input: VerifyInput = {},
): Effect {
  // A missing target is a failure of the action, not of the verifier, but the
  // verifier's only honest output here is that it learned nothing.
  if (!el) return UNKNOWN

  switch (action) {
    case 'fill': {
      if (isPassword(el)) return UNKNOWN
      const expected = input.expected
      if (expected === undefined) return UNKNOWN
      if (tagOf(el) === 'input' || tagOf(el) === 'textarea') {
        return (el as HTMLInputElement).value === expected ? 'confirmed' : 'unchanged'
      }
      // contenteditable
      if (el.getAttribute('contenteditable') === 'true') {
        return el.textContent === expected ? 'confirmed' : 'unchanged'
      }
      return UNKNOWN
    }

    case 'select': {
      if (tagOf(el) !== 'select') return UNKNOWN
      const expected = input.expected
      if (expected === undefined) return UNKNOWN
      return (el as HTMLSelectElement).value === expected ? 'confirmed' : 'unchanged'
    }

    case 'click':
    case 'focus':
    case 'hover': {
      // Inert wins over any probe, unconditionally.
      if (isInert(el)) return 'unchanged'
      if (action !== 'click') return UNKNOWN
      const probe = safeProbe(input)
      if (!probe) return UNKNOWN
      if (probe.responded === true) return 'confirmed'
      if (probe.responded === false) return 'unchanged'
      if (probe.changed === true) return 'changed'
      if (probe.navigated === true) return 'confirmed'
      return UNKNOWN
    }

    case 'scroll':
    case 'navigate':
    case 'wait_for':
    // Not observable from a content script. Say so.
    case 'none':
    case 'ask_user':
      return UNKNOWN

    default:
      // An action this build does not know about cannot be verified.
      return UNKNOWN
  }
}
