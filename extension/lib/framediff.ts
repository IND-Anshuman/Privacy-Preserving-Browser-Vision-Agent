/**
 * Frame-difference gate + DOM structural hash — ARCHITECTURE.md §7.
 * Pure functions only, so they are unit-testable without a browser and so the
 * same code can run in a Worker, the offscreen doc, or a benchmark harness.
 */

export const THUMB = 64
export const TILE = 64

/* ================================================================== *
 *  dHash: 64x64 luma → 64-bit perceptual hash
 * ================================================================== */

const LUMA = [0.299, 0.587, 0.114]

/** RGBA ImageData (or any {data,width,height}) → Float32Array of 64x64 luma. */
export function toLumaThumbnail(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  out?: Float32Array,
): Float32Array {
  const dst = out ?? new Float32Array(THUMB * THUMB)
  const scaleX = width / THUMB
  const scaleY = height / THUMB
  for (let y = 0; y < THUMB; y++) {
    // Box-average over the source region for this thumbnail row: less aliasing
    // than point sampling, still cheap enough for the GPU-side fast path.
    const sy0 = Math.floor(y * scaleY)
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * scaleY))
    for (let x = 0; x < THUMB; x++) {
      const sx0 = Math.floor(x * scaleX)
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * scaleX))
      let sum = 0
      let n = 0
      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < width; sx++) {
          const i = (sy * width + sx) * 4
          sum += data[i]! * LUMA[0]! + data[i + 1]! * LUMA[1]! + data[i + 2]! * LUMA[2]!
          n++
        }
      }
      dst[y * THUMB + x] = n > 0 ? sum / n : 0
    }
  }
  return dst
}

/** 64-bit dHash packed into a 16-char hex string (two 32-bit halves). */
export function dhash(luma: Float32Array): string {
  let lo = 0
  let hi = 0
  let bit = 0
  for (let y = 0; y < THUMB; y++) {
    for (let x = 0; x < THUMB - 1; x++) {
      const a = luma[y * THUMB + x]!
      const b = luma[y * THUMB + x + 1]!
      if (a > b) {
        if (bit < 32) lo |= 1 << bit
        else hi |= 1 << (bit - 32)
      }
      bit++
    }
  }
  return (lo >>> 0).toString(16).padStart(8, '0') + (hi >>> 0).toString(16).padStart(8, '0')
}

export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i += 8) {
    const x = parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)
    d += popcount(x >>> 0)
  }
  return d
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  v = (v + (v >>> 4)) & 0x0f0f0f0f
  return (v * 0x01010101) >>> 24
}

/** Mean absolute difference between two thumbnails, 0..255. */
export function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
  return s / a.length
}

/* ================================================================== *
 *  Dirty tiles
 * ================================================================== */

export interface TileRect {
  tx: number
  ty: number
  tw: number
  th: number
  /** Fraction of pixels that changed, 0..1. */
  change: number
  /**
   * The grid this rect indexes, as [cols, rows] of the 64×64 luma thumbnail.
   *
   * Carried on the rect rather than imported as a constant because the grid is
   * a per-call option (`evaluateGate({cols, rows})`, default 4×4). A consumer
   * that assumed a fixed grid would place every crop in the wrong place — and
   * it would look plausible, because the tile still contained pixels.
   */
  cols: number
  rows: number
}

const TILE_CHANGE_THRESHOLD = 0.02

/** Which 64x64 tiles of the source frame differ enough to matter. */
export function dirtyTiles(
  prev: Float32Array,
  next: Float32Array,
  cols: number,
  rows: number,
  threshold = TILE_CHANGE_THRESHOLD,
): TileRect[] {
  const out: TileRect[] = []
  const perTile = (THUMB * THUMB) / (cols * rows)
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = Math.floor((tx * THUMB) / cols)
      const x1 = Math.floor(((tx + 1) * THUMB) / cols)
      const y0 = Math.floor((ty * THUMB) / rows)
      const y1 = Math.floor(((ty + 1) * THUMB) / rows)
      let changed = 0
      let total = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * THUMB + x
          if (Math.abs(prev[i]! - next[i]!) > 6) changed++
          total++
        }
      }
      const frac = total > 0 ? changed / total : 0
      if (frac > threshold) out.push({ tx, ty, tw: 1, th: 1, change: frac, cols, rows })
    }
  }
  void perTile
  return out
}

/**
 * Merge dirty tiles into as few axis-aligned rectangles as possible.
 * Greedy row-run merge: each unvisited seed grows right along its row, then the
 * whole run grows down while the rows below line up. Good enough for delta-tile
 * upload (fewer, bigger tiles) and cheap enough to run every frame.
 */
export function coalesceTiles(tiles: TileRect[]): TileRect[] {
  if (tiles.length === 0) return []
  const occupied = new Set<string>()
  for (const t of tiles) {
    for (let y = 0; y < t.th; y++) {
      for (let x = 0; x < t.tw; x++) occupied.add(`${t.tx + x},${t.ty + y}`)
    }
  }
  const out: TileRect[] = []

  for (const seed of tiles) {
    if (!occupied.has(`${seed.tx},${seed.ty}`)) continue

    // Grow right: consecutive occupied cells in this row.
    let tw = 1
    while (occupied.has(`${seed.tx + tw},${seed.ty}`)) tw++

    // Grow down while every cell of the current width is occupied.
    let th = 1
    for (;;) {
      let full = true
      for (let x = 0; x < tw; x++) {
        if (!occupied.has(`${seed.tx + x},${seed.ty + th}`)) {
          full = false
          break
        }
      }
      if (!full) break
      th++
    }

    let change = 0
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        occupied.delete(`${seed.tx + x},${seed.ty + y}`)
        const t = tiles.find((c) => c.tx === seed.tx + x && c.ty === seed.ty + y)
        if (t) change = Math.max(change, t.change)
      }
    }
    // cols/rows come from the seed tile itself, so a caller that used a
    // non-default grid gets correct coordinates back out of the coalescer.
    out.push({ tx: seed.tx, ty: seed.ty, tw, th, change, cols: seed.cols, rows: seed.rows })
  }
  return out
}

/* ================================================================== *
 *  DOM structural hash — the second half of the gate (§7.3)
 * ================================================================== */

export interface StructuralInput {
  role: string
  label?: string
  valueClass?: string
  mark?: number
  actions?: readonly string[]
}

/**
 * Hash of the *pruned* snapshot, deliberately ignoring text values and boxes:
 * a value typed into a field must not invalidate the cache on its own, but a
 * new button must.
 */
export function domStructuralHash(nodes: readonly StructuralInput[]): string {
  const canon = nodes
    .map((n) => `${n.role}|${(n.label ?? '').slice(0, 40)}|${n.valueClass ?? ''}|${n.mark ?? -1}|${(n.actions ?? []).join(',')}`)
    .join('\n')
  return fnv1a(canon)
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/* ================================================================== *
 *  The gate itself
 * ================================================================== */

export interface GateState {
  prevLuma: Float32Array | null
  prevDomHash: string | null
  prevFrameHash: string | null
}

export function newGateState(): GateState {
  return { prevLuma: null, prevDomHash: null, prevFrameHash: null }
}

export interface GateDecision {
  /** false → skip the whole pipeline (§7.3). */
  proceed: boolean
  /** Only these tiles need re-detection. */
  tiles: TileRect[]
  hamming: number
  mad: number
  domChanged: boolean
  reason: string
}

export interface GateOptions {
  /** dHash Hamming distance below which the pixels count as unchanged. */
  hammingThreshold?: number
  /** Mean abs diff below which the pixels count as unchanged. */
  madThreshold?: number
  cols?: number
  rows?: number
}

export function evaluateGate(
  state: GateState,
  luma: Float32Array,
  domHash: string,
  opts: GateOptions = {},
): GateDecision {
  const hammingThreshold = opts.hammingThreshold ?? 2
  const madThreshold = opts.madThreshold ?? 1.2
  const cols = opts.cols ?? 4
  const rows = opts.rows ?? 4

  if (state.prevLuma === null || state.prevDomHash === null) {
    return { proceed: true, tiles: [], hamming: 64, mad: 255, domChanged: true, reason: 'first frame' }
  }

  const domChanged = state.prevDomHash !== domHash
  const h = dhash(luma)
  const hamming = hammingHex(h, state.prevFrameHash ?? '0'.repeat(16))
  const mad = meanAbsDiff(luma, state.prevLuma)

  const pixelsChanged = hamming > hammingThreshold || mad > madThreshold
  if (!pixelsChanged && !domChanged) {
    return { proceed: false, tiles: [], hamming, mad, domChanged, reason: 'pixels + DOM unchanged' }
  }

  const tiles = pixelsChanged ? coalesceTiles(dirtyTiles(state.prevLuma, luma, cols, rows)) : []
  return {
    proceed: true,
    tiles,
    hamming,
    mad,
    domChanged,
    reason: pixelsChanged && domChanged ? 'pixels + DOM changed' : pixelsChanged ? 'pixels changed' : 'DOM changed',
  }
}

export function commitGate(state: GateState, luma: Float32Array, domHash: string): void {
  state.prevLuma = luma
  state.prevDomHash = domHash
  state.prevFrameHash = dhash(luma)
}
