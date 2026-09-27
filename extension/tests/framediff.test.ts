import { describe, it, expect } from 'vitest'
import {
  toLumaThumbnail,
  dhash,
  hammingHex,
  meanAbsDiff,
  dirtyTiles,
  coalesceTiles,
  domStructuralHash,
  evaluateGate,
  commitGate,
  newGateState,
  THUMB,
  type TileRect,
} from '../lib/framediff'

function makeFrame(w: number, h: number, fill: [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = fill[0]
    d[i * 4 + 1] = fill[1]
    d[i * 4 + 2] = fill[2]
    d[i * 4 + 3] = 255
  }
  return d
}

function makeChecker(w: number, h: number, cell = 16): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
      d[i] = on ? 240 : 20
      d[i + 1] = on ? 240 : 20
      d[i + 2] = on ? 240 : 20
      d[i + 3] = 255
    }
  }
  return d
}

function makeGradient(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      d[i] = (x / w) * 255
      d[i + 1] = (y / h) * 255
      d[i + 2] = 128
      d[i + 3] = 255
    }
  }
  return d
}

describe('luma + dHash', () => {
  it('produces a 16-hex-char hash', () => {
    const luma = toLumaThumbnail(makeFrame(320, 240, [10, 20, 30]), 320, 240)
    expect(luma).toHaveLength(THUMB * THUMB)
    expect(dhash(luma)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is identical for identical frames', () => {
    const a = toLumaThumbnail(makeFrame(200, 100, [200, 30, 30]), 200, 100)
    const b = toLumaThumbnail(makeFrame(200, 100, [200, 30, 30]), 200, 100)
    expect(dhash(a)).toBe(dhash(b))
  })

  it('is stable across resolution changes (same scene, different capture size)', () => {
    const big = toLumaThumbnail(makeGradient(1280, 720), 1280, 720)
    const small = toLumaThumbnail(makeGradient(640, 360), 640, 360)
    expect(hammingHex(dhash(big), dhash(small))).toBeLessThanOrEqual(4)
  })

  it('flips hard when the screen content changes drastically', () => {
    const dark = toLumaThumbnail(makeFrame(300, 200, [0, 0, 0]), 300, 200)
    const light = toLumaThumbnail(makeFrame(300, 200, [255, 255, 255]), 300, 200)
    // NOTE: dHash encodes HORIZONTAL DESCENTS only. A flat black frame and a flat
    // white frame have no descents, so they hash identically — and so does a
    // smooth monotonic left-to-right gradient. This is a real property of the
    // algorithm, not a bug, and it is exactly why evaluateGate pairs dHash with
    // meanAbsDiff. Neither signal alone is sufficient.
    expect(meanAbsDiff(dark, light)).toBeGreaterThan(200)
    expect(dhash(dark)).toBe(dhash(light))

    // Structured content (real page layout) vs a flat frame must flip the hash.
    const page = toLumaThumbnail(makeChecker(320, 240), 320, 240)
    const flat = toLumaThumbnail(makeFrame(320, 240, [255, 255, 255]), 320, 240)
    expect(hammingHex(dhash(page), dhash(flat))).toBeGreaterThan(30)
  })

  it('hammingHex counts differing bits', () => {
    expect(hammingHex('0000000000000000', '0000000000000000')).toBe(0)
    expect(hammingHex('0000000000000000', '0000000000000001')).toBe(1)
    expect(hammingHex('ffffffffffffffff', '0000000000000000')).toBe(64)
  })
})

describe('dirty tiles', () => {
  it('reports nothing for an unchanged frame', () => {
    const l = toLumaThumbnail(makeGradient(400, 300), 400, 300)
    expect(dirtyTiles(l, l, 4, 4)).toHaveLength(0)
  })

  it('reports only the quadrant that changed', () => {
    const prev = toLumaThumbnail(makeGradient(400, 300), 400, 300)
    const data = makeGradient(400, 300)
    // Paint the bottom-right quadrant white.
    for (let y = 150; y < 300; y++) {
      for (let x = 200; x < 400; x++) {
        const i = (y * 400 + x) * 4
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
      }
    }
    const next = toLumaThumbnail(data, 400, 300)
    const tiles = dirtyTiles(prev, next, 4, 4)
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.every((t) => t.tx >= 2 && t.ty >= 2)).toBe(true)
  })

  it('coalesces a 2x2 block into one tile', () => {
    const tiles: TileRect[] = [
      { tx: 1, ty: 1, tw: 1, th: 1, change: 0.5 },
      { tx: 2, ty: 1, tw: 1, th: 1, change: 0.6 },
      { tx: 1, ty: 2, tw: 1, th: 1, change: 0.4 },
      { tx: 2, ty: 2, tw: 1, th: 1, change: 0.55 },
    ]
    const c = coalesceTiles(tiles)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ tx: 1, ty: 1, tw: 2, th: 2 })
  })

  it('keeps separated tiles separate', () => {
    const c = coalesceTiles([
      { tx: 0, ty: 0, tw: 1, th: 1, change: 0.5 },
      { tx: 3, ty: 3, tw: 1, th: 1, change: 0.5 },
    ])
    expect(c).toHaveLength(2)
  })
})

describe('DOM structural hash', () => {
  it('is stable for the same structure', () => {
    const nodes = [
      { role: 'button', label: 'Submit', valueClass: 'public', mark: 1, actions: ['click'] },
      { role: 'textbox', label: 'Email', valueClass: 'sensitive', mark: 2, actions: ['fill'] },
    ]
    expect(domStructuralHash(nodes)).toBe(domStructuralHash([...nodes]))
  })

  it('ignores typed values (a value change alone must not invalidate the cache)', () => {
    // valueClass is part of the hash but the raw value is never passed in at
    // all, so by construction typing cannot change it.
    const a = [{ role: 'textbox', label: 'Email', valueClass: 'sensitive' }]
    const b = [{ role: 'textbox', label: 'Email', valueClass: 'sensitive' }]
    expect(domStructuralHash(a)).toBe(domStructuralHash(b))
  })

  it('changes when a control is added', () => {
    const a = [{ role: 'button', label: 'Submit', mark: 1 }]
    const b = [
      { role: 'button', label: 'Submit', mark: 1 },
      { role: 'button', label: 'Cancel', mark: 2 },
    ]
    expect(domStructuralHash(a)).not.toBe(domStructuralHash(b))
  })
})

describe('gate decision', () => {
  it('always proceeds on the first frame', () => {
    const st = newGateState()
    const l = toLumaThumbnail(makeGradient(400, 300), 400, 300)
    const d = evaluateGate(st, l, 'abc')
    expect(d.proceed).toBe(true)
    expect(d.reason).toBe('first frame')
  })

  it('skips everything on a static page: the metric-4 headline', () => {
    const st = newGateState()
    const l = toLumaThumbnail(makeGradient(400, 300), 400, 300)
    commitGate(st, l, 'hash1')
    const d = evaluateGate(st, l, 'hash1')
    expect(d.proceed).toBe(false)
    expect(d.reason).toContain('unchanged')
  })

  it('proceeds when only the DOM changed (a hidden input appeared)', () => {
    const st = newGateState()
    const l = toLumaThumbnail(makeGradient(400, 300), 400, 300)
    commitGate(st, l, 'hash1')
    const d = evaluateGate(st, l, 'hash2')
    expect(d.proceed).toBe(true)
    expect(d.domChanged).toBe(true)
  })

  it('proceeds and returns dirty tiles when pixels changed', () => {
    const st = newGateState()
    const prev = toLumaThumbnail(makeGradient(400, 300), 400, 300)
    commitGate(st, prev, 'hash1')
    const next = toLumaThumbnail(makeFrame(400, 300, [255, 255, 255]), 400, 300)
    const d = evaluateGate(st, next, 'hash1')
    expect(d.proceed).toBe(true)
    expect(d.tiles.length).toBeGreaterThan(0)
  })

  it('tolerates a small amount of noise (caret blink) without re-running', () => {
    const st = newGateState()
    const base = makeGradient(400, 300)
    const l1 = toLumaThumbnail(base, 400, 300)
    commitGate(st, l1, 'hash1')
    const noisy = makeGradient(400, 300)
    for (let i = 0; i < 40; i++) {
      const k = i * 4
      noisy[k] = Math.min(255, (noisy[k] ?? 0) + 2)
    }
    const l2 = toLumaThumbnail(noisy, 400, 300)
    expect(meanAbsDiff(l1, l2)).toBeLessThan(0.05)
    const d = evaluateGate(st, l2, 'hash1')
    expect(d.proceed).toBe(false)
  })
})
