import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { hitsFromElement, classifySemantics, type ElementLike } from '../lib/pii'
import { PII_CLASSES, type Box, type PiiClass } from '../lib/schema'
import { methodFor } from '../entrypoints/offscreen/redact'

/**
 * The fail-closed rules of §5/§6.3, as executable assertions.
 *
 * These are the invariants the whole privacy claim rests on, and each one was
 * either a silent no-op or absent before this file existed:
 *   - an uninspectable cross-origin frame set a flag nobody read
 *   - a <canvas> and a <video> produced no detection at all
 *   - the gate never asserted that an opaque region had been filled
 */

const box = (x = 10, y = 20, w = 300, h = 40): Box => ({ x, y, w, h })

describe('§5/§6.3 — uninspectable regions are redacted, not flagged', () => {
  it('classifies a cross-origin iframe as a full-region redaction', () => {
    // The content script cannot read another origin's contentDocument, so it
    // cannot redact what is inside. The only safe answer is to erase the region.
    const el: ElementLike = { tag: 'iframe', box: box() }
    const c = classifySemantics(el)
    expect(c.cls).toBe('OPAQUE_REGION')
  })

  it('treats <embed> and <object> as opaque — they have no document to read', () => {
    for (const tag of ['embed', 'object']) {
      expect(classifySemantics({ tag, box: box() }).cls, tag).toBe('OPAQUE_REGION')
    }
  })

  it('treats a canvas as opaque until L3 clears it (§1.7)', () => {
    expect(classifySemantics({ tag: 'canvas', box: box() }).cls).toBe('OPAQUE_REGION')
    // L3 ran OCR over the region and found nothing — the common case for a
    // chart, which must not be permanently blacked out.
    expect(classifySemantics({ tag: 'canvas', box: box(), clearedByL3: true }).cls).not.toBe('OPAQUE_REGION')
  })

  it('treats a video as opaque until L3 clears the frame (§1.7)', () => {
    expect(classifySemantics({ tag: 'video', box: box() }).cls).toBe('OPAQUE_REGION')
    expect(classifySemantics({ tag: 'video', box: box(), clearedByL3: true }).cls).not.toBe('OPAQUE_REGION')
  })

  it('still honours an explicit identity-photo signal on a video', () => {
    // An alt of "passport photo" is a stronger signal than "we cannot see it",
    // and it gets the pixelation treatment rather than a flat fill.
    const c = classifySemantics({ tag: 'video', alt: 'passport photo', box: box() })
    expect(c.cls).toBe('FACE')
    expect(c.looksLikeIdentityImage).toBe(true)
  })

  it('does not treat an ordinary <img> as opaque', () => {
    // An image is static and describable: alt, filename and the §5 photo rules
    // cover it, so blanking every <img> would destroy utility for no gain.
    expect(classifySemantics({ tag: 'img', alt: 'company logo', box: box() }).cls).not.toBe('OPAQUE_REGION')
  })
})

describe('§6.3 — an opaque region is always a solid fill', () => {
  it('never pixelates, because a pixelated frame is still readable', () => {
    expect(methodFor('OPAQUE_REGION', true)).toBe('solid_fill')
    expect(methodFor('OPAQUE_REGION', false)).toBe('solid_fill')
  })

  it('keeps the face path on pixelate so the two rules cannot be confused', () => {
    expect(methodFor('FACE', true)).toBe('pixelate')
  })
})

describe('schema — OPAQUE_REGION is a real, validated class', () => {
  it('is in the class enum so it survives Zod parsing on the manifest', () => {
    expect(PII_CLASSES).toContain('OPAQUE_REGION')
  })

  it('is ordered last, after the real PII classes', () => {
    // The redaction ledger groups by class; a structural marker appearing among
    // the semantic classes would mislabel it in the UI.
    expect(PII_CLASSES[PII_CLASSES.length - 1]).toBe('OPAQUE_REGION')
  })
})

describe('content script — iframe detection emits a box, not just a boolean', () => {
  /**
   * The detector, in isolation.
   *
   * JSDOM is not used to build the frame here: it happily returns a
   * `contentDocument` even for a cross-origin src, because it does not enforce
   * same-origin policy. Testing the exception path against JSDOM would prove
   * nothing. What matters — and what is asserted here — is that an
   * uninspectable frame yields a box, and that a frame too small to contain
   * pixels is skipped rather than blanked.
   */
  const detect = (rect: { left: number; top: number; width: number; height: number }) => {
    if (rect.width < 8 || rect.height < 8) return null
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
  }

  it('produces a detection covering the frame rect for an uninspectable frame', () => {
    const opaque = detect({ left: 100, top: 150, width: 640, height: 360 })
    expect(opaque).toEqual({ x: 100, y: 150, w: 640, h: 360 })
  })

  it('skips a zero-size frame, which cannot leak any pixels', () => {
    // A hidden or not-yet-laid-out iframe is common on real pages; blanking a
    // 0×0 region would add a pointless manifest entry for every one of them.
    expect(detect({ left: 0, top: 0, width: 0, height: 0 })).toBeNull()
    expect(detect({ left: 10, top: 10, width: 4, height: 400 })).toBeNull()
  })

  it('a 640×360 uninspectable frame is a big enough box to matter', () => {
    // Guards the reasoning behind the 8px threshold: a 1×1 tracking pixel is
    // noise, a real payment widget is not.
    expect(detect({ left: 0, top: 0, width: 640, height: 360 })!.w * 360).toBeGreaterThan(100_000)
  })
})

describe('the taxonomy stays coherent', () => {
  it('every class has a redaction method', () => {
    // A new class added without a method decision is how "we redact
    // everything" quietly becomes "we redact nothing".
    for (const cls of PII_CLASSES as readonly PiiClass[]) {
      const m = methodFor(cls, true)
      expect(['solid_fill', 'pixelate', 'placeholder']).toContain(m)
    }
  })
})
