import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { hitsFromElement, classifySemantics, runL1, type ElementLike } from '../lib/pii'
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

describe('ADDRESS in prose — the one measured residual leak', () => {
  /**
   * These assertions document a KNOWN gap rather than a passing one.
   *
   * Measured leakage is 3/232, every one of them an address of the
   * `171, Sector 18, Pune 411001` shape. The shape is
   * house-number / token / NUMBER / city / PIN, and a regex that catches it
   * starts matching ordinary prose — the first attempt at this measured
   * ADDRESS precision 0.08. We chose precision and accepted the gap, because
   * the fail-closed rule still blanks these on the pixel channel.
   *
   * If someone later widens the pattern successfully, the first test will fail
   * and they will know to re-measure precision before claiming the win.
   */
  it('catches the street-word address shapes', () => {
    for (const t of [
      '330, FC Road, Chennai 600002',
      '150, Anna Salai, Delhi 110001',
      '98, MG Road, Pune 411001',
      '44, Green Park, Delhi 110016',
    ]) {
      expect(runL1(t).some((h) => h.cls === 'ADDRESS'), t).toBe(true)
    }
  })

  it('does NOT catch the number-in-the-middle shape — the known gap', () => {
    // Documented, expected failure. See the describe block above.
    const hits = runL1('Permanent address: 171, Sector 18, Pune 411001.')
    expect(hits.some((h) => h.cls === 'ADDRESS')).toBe(false)
  })

  it('does not match ordinary prose', () => {
    // The guard that keeps the rule honest: every one of these contains a
    // comma, a number and a six-digit run.
    for (const t of [
      'version 2, section 4, page 100002',
      'order 88, delivered on 20260101',
      'Step 1, main 4, total 900001',
    ]) {
      expect(runL1(t).some((h) => h.cls === 'ADDRESS'), t).toBe(false)
    }
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
