import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { verifyEffect } from '../lib/verify'

/**
 * Post-action verification — audit finding 1.3.
 *
 * The executor returned `{ ok: true }` as a literal after calling
 * `el.click()` or `setNativeValue()`. A click on a disabled button, a fill
 * into a controlled React input that rejects the value, and a genuinely
 * successful fill were all byte-identical to the caller.
 *
 * The rule this file encodes: dispatching an event proves that a listener
 * received a notification. It does NOT prove the page changed. So the only
 * honest default is `unknown`, and each action earns its way to `confirmed`
 * only by producing positive evidence.
 */

function dom(html: string): Document {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document
}

describe('fill', () => {
  it('confirms when the value actually landed in a plain input', () => {
    const d = dom('<input id="a" value="">')
    const el = d.getElementById('a') as HTMLInputElement
    el.value = 'hello'
    expect(verifyEffect('fill', el, { expected: 'hello' })).toBe('confirmed')
  })

  it('reports unchanged when a framework rejected the write', () => {
    // React and friends re-render and restore the previous value. The value
    // setter ran, the event fired, and nothing changed.
    const d = dom('<input id="a" value="original">')
    const el = d.getElementById('a') as HTMLInputElement
    expect(verifyEffect('fill', el, { expected: 'ignored' })).toBe('unchanged')
  })

  it('does not report success when the element is a password field', () => {
    // Password values are never echoed back anywhere; asserting on the value
    // would mean comparing secrets to a secret.
    const d = dom('<input type="password" id="a">')
    const el = d.getElementById('a') as HTMLInputElement
    el.value = 'hunter2'
    expect(verifyEffect('fill', el, { expected: 'hunter2' })).not.toBe('confirmed')
  })

  it('is unknown when there was no element to check', () => {
    expect(verifyEffect('fill', null, { expected: 'x' })).toBe('unknown')
  })
})

describe('click', () => {
  it('confirms when the control responded to the click', () => {
    const d = dom('<button id="b">Go</button>')
    const el = d.getElementById('b') as HTMLButtonElement
    let fired = 0
    el.addEventListener('click', () => { fired++ })
    el.click()
    expect(verifyEffect('click', el, { probe: () => ({ responded: fired > 0 }) })).toBe('confirmed')
  })

  it('reports unchanged when nothing responded', () => {
    const d = dom('<button id="b">Go</button>')
    const el = d.getElementById('b') as HTMLButtonElement
    expect(verifyEffect('click', el, { probe: () => ({ responded: false }) })).toBe('unchanged')
  })

  it('refuses to confirm a click on a disabled control', () => {
    const d = dom('<button id="b" disabled>Go</button>')
    const el = d.getElementById('b') as HTMLButtonElement
    // Even if a probe claims a response, a disabled control cannot have run.
    expect(verifyEffect('click', el, { probe: () => ({ responded: true }) })).not.toBe('confirmed')
  })

  it('refuses to confirm a click on an invisible control', () => {
    const d = dom('<button id="b" style="display:none">Go</button>')
    const el = d.getElementById('b') as HTMLButtonElement
    expect(verifyEffect('click', el, { probe: () => ({ responded: true }) })).not.toBe('confirmed')
  })
})

describe('select', () => {
  it('confirms when the chosen option is the selected one', () => {
    const d = dom('<select id="s"><option value="a">A</option><option value="b">B</option></select>')
    const el = d.getElementById('s') as HTMLSelectElement
    el.value = 'b'
    expect(verifyEffect('select', el, { expected: 'b' })).toBe('confirmed')
  })

  it('reports unchanged when the option does not exist', () => {
    const d = dom('<select id="s"><option value="a">A</option></select>')
    const el = d.getElementById('s') as HTMLSelectElement
    el.value = 'nope'
    expect(verifyEffect('select', el, { expected: 'nope' })).toBe('unchanged')
  })

  it('is unknown on a non-select element', () => {
    const d = dom('<div id="s"></div>')
    expect(verifyEffect('select', d.getElementById('s'), { expected: 'a' })).toBe('unknown')
  })
})

describe('checkbox and other stateful controls', () => {
  it('confirms a toggle when the checked state flipped', () => {
    const d = dom('<input type="checkbox" id="c">')
    const el = d.getElementById('c') as HTMLInputElement
    el.checked = true
    expect(verifyEffect('click', el, { probe: () => ({ responded: true }) })).not.toBe('unknown')
  })
})

describe('actions with no observable local effect', () => {
  it.each(['scroll', 'navigate', 'focus', 'hover'])('%s is unknown, never confirmed', (action) => {
    const d = dom('<div id="x">hi</div>')
    expect(verifyEffect(action, d.getElementById('x'), { probe: () => ({ responded: true }) })).toBe('unknown')
  })

  it('wait_for is unknown — a sleep proves nothing about the page', () => {
    expect(verifyEffect('wait_for', null, {})).toBe('unknown')
  })
})

describe('fail-closed default', () => {
  it('an unknown action is unknown, not confirmed', () => {
    const d = dom('<div id="x"></div>')
    expect(verifyEffect('teleport', d.getElementById('x'), { probe: () => ({ responded: true }) })).toBe('unknown')
  })

  it('a missing probe means unknown even for a click', () => {
    const d = dom('<button id="b">Go</button>')
    expect(verifyEffect('click', d.getElementById('b'), {})).toBe('unknown')
  })
})

describe('probe shape', () => {
  it('tolerates a null probe result', () => {
    const d = dom('<button id="b">Go</button>')
    const el = d.getElementById('b') as HTMLButtonElement
    expect(verifyEffect('click', el, { probe: () => null })).toBe('unknown')
  })

  it('a probe that throws degrades to unknown rather than failing the run', () => {
    const d = dom('<button id="b">Go</button>')
    const el = d.getElementById('b') as HTMLButtonElement
    const probe = (): never => { throw new Error('detached') }
    expect(verifyEffect('click', el, { probe })).toBe('unknown')
  })
})
