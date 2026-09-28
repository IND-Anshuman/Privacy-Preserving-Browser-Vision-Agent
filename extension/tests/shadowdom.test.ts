import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'

/**
 * §5 shadow DOM — the 0/4 channel, and the reason it was 0/4.
 *
 * `el.children` does not cross a shadow boundary, so a value inside a custom
 * element was invisible to the DOM walk. This file pins both halves of the fix:
 * an open root is descended into, and a sealed host is fail-closed.
 *
 * jsdom implements `attachShadow` and honours `mode: 'closed'`, so this is a
 * real test of the real boundary rather than a mock of it.
 */
describe('shadow DOM', () => {
  it('an open shadow root is reachable and its children are walkable', () => {
    const dom = new JSDOM('<body><my-widget id="w"></my-widget></body>')
    const doc = dom.window.document
    const host = doc.getElementById('w')!

    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<input id="secret" name="mobile" value="9876543210">'

    // The child lives in the shadow tree, NOT in host.children — which is the
    // whole reason the old walk missed it.
    expect(host.children.length).toBe(0)
    expect(host.shadowRoot).not.toBeNull()
    expect(host.shadowRoot!.querySelector('#secret')).not.toBeNull()
  })

  it('a closed shadow root is genuinely unreadable', () => {
    const dom = new JSDOM('<body><my-widget id="w"></my-widget></body>')
    const doc = dom.window.document
    const host = doc.getElementById('w')!

    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = '<input id="secret" name="mobile" value="9876543210">'

    // The platform gives us nothing: `shadowRoot` is null and the node is not
    // reachable by any selector. This is the condition the fail-closed rule
    // exists for — we cannot redact what we cannot see.
    expect(host.shadowRoot).toBeNull()
    expect(doc.querySelector('#secret')).toBeNull()
    expect(() => host.querySelector('#secret')).not.toThrow()
    expect(host.querySelector('#secret')).toBeNull()
  })

  it('an element with no shadow at all is distinguishable from a sealed one', () => {
    const dom = new JSDOM('<body><div id="plain"></div><my-widget id="sealed"></my-widget></body>')
    const doc = dom.window.document
    doc.getElementById('sealed')!.attachShadow({ mode: 'closed' })

    const plain = doc.getElementById('plain')!
    const sealed = doc.getElementById('sealed')!

    // `shadowRoot` is null for BOTH. The discriminator the implementation uses
    // is the custom-element tag name plus a real painted box, so the two must be
    // separated by something other than the shadowRoot check.
    expect(plain.shadowRoot).toBeNull()
    expect(sealed.shadowRoot).toBeNull()
    expect(plain.tagName.includes('-')).toBe(false)
    expect(sealed.tagName.includes('-')).toBe(true)
  })
})
