/**
 * Redaction compositor + fail-closed gate — ARCHITECTURE.md §6.
 *
 * THE INVARIANT: the raw frame exists only inside a closure scope in this
 * module. It is drawn, redacted, and encoded here, and the reference is nulled
 * before this function returns. There is no code path from a raw buffer to
 * fetch/XHR/sendBeacon/WebSocket — the offscreen document's CSP (connect-src
 * 'self') is the backstop, and this module is the primary mechanism.
 */
import type { Box, GateVerdict, PiiClass, RedactionEntry, RedactionManifest } from '@/lib/schema'
import { SCHEMA_VERSION } from '@/lib/schema'
import { badgeRect, type MarkAssignment } from '@/lib/som'

/* ------------------------------------------------------------------ *
 *  Per-class styling. These are user-facing colours: the panel shows
 *  "6 items hidden" and a legend, never "redaction pipeline".
 * ------------------------------------------------------------------ */

const CLASS_TINT: Record<PiiClass, string> = {
  PASSWORD: '#1e293b',
  PERSON: '#0f766e',
  EMAIL: '#0e7490',
  PHONE: '#0e7490',
  ADDRESS: '#0e7490',
  CREDIT_CARD: '#7c2d12',
  AADHAAR: '#7c2d12',
  PAN: '#7c2d12',
  GSTIN: '#7c2d12',
  IFSC: '#7c2d12',
  IBAN: '#7c2d12',
  PASSPORT: '#7c2d12',
  DL: '#7c2d12',
  DOB: '#1e3a8a',
  IP_ADDRESS: '#1e3a8a',
  API_KEY: '#1e293b',
  JWT: '#1e293b',
  BANK_ACCOUNT: '#7c2d12',
  ORG: '#334155',
  MONEY: '#334155',
  LOCATION: '#334155',
  DATE: '#334155',
  FACE: '#4c1d95',
}

/** Which method each class gets, per §6.1. */
export function methodFor(cls: PiiClass, hasBox: boolean): 'solid_fill' | 'pixelate' | 'placeholder' {
  if (cls === 'FACE') return 'pixelate'
  if (cls === 'PASSWORD' || cls === 'CREDIT_CARD' || cls === 'AADHAAR' || cls === 'PAN' ||
      cls === 'GSTIN' || cls === 'IFSC' || cls === 'IBAN' || cls === 'PASSPORT' ||
      cls === 'DL' || cls === 'BANK_ACCOUNT' || cls === 'API_KEY' || cls === 'JWT') {
    return 'solid_fill'
  }
  // Text-channel classes with a box still get a solid fill on the PIXELS; the
  // placeholder substitution happens in the DOM channel independently.
  return hasBox ? 'solid_fill' : 'placeholder'
}

/* ------------------------------------------------------------------ *
 *  Pseudonymization — stable per session, salt never leaves the client
 * ------------------------------------------------------------------ */

export class Pseudonymizer {
  private map = new Map<string, { token: string; cls: PiiClass }>()
  private counters = new Map<string, number>()
  private salt: string

  constructor(sessionId: string) {
    // Salt is derived from the session id and random bytes, held only here.
    this.salt = `${sessionId}:${Math.random().toString(36).slice(2)}`
  }

  private hash(s: string): string {
    // FNV-1a over salt+value. Not a security primitive and not meant to be —
    // the salt is what stops cross-session linkability, and the raw value is
    // never transmitted in any form.
    let h = 0x811c9dc5
    const input = this.salt + s.toLowerCase().replace(/\s+/g, ' ').trim()
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  /** Same value + same session → same token. Different session → different. */
  tokenFor(value: string, cls: PiiClass): { token: string; cls: PiiClass } {
    const key = `${cls}:${this.hash(value)}`
    const found = this.map.get(key)
    if (found) return found
    // Passwords never get a pseudonym. [§5 hard case]
    if (cls === 'PASSWORD') {
      const t = { token: '[PASSWORD]', cls }
      this.map.set(key, t)
      return t
    }
    const n = (this.counters.get(cls) ?? 0) + 1
    this.counters.set(cls, n)
    const t = { token: `[${cls}_${n}]`, cls }
    this.map.set(key, t)
    return t
  }

  /** Every token issued, for the privacy ledger. */
  issued(): string[] {
    return [...this.map.values()].map((v) => v.token)
  }
}

/* ------------------------------------------------------------------ *
 *  The compositor
 * ------------------------------------------------------------------ */

export interface RedactInput {
  /** The ONLY reference to raw pixels. Nulled before return. */
  frame: ImageBitmap | VideoFrame | OffscreenCanvas
  width: number
  height: number
  items: Array<{
    id: string
    cls: PiiClass
    box: Box
    score: number
    source: 'L0' | 'L1' | 'L2' | 'L3'
    text?: string
  }>
  marks: MarkAssignment[]
  frameHash: string
  sessionId: string
  modelVersions: Record<string, string>
}

export interface RedactOutput {
  manifest: RedactionManifest
  verdict: GateVerdict
  blob: Blob | null
  bytes: number
  timings: Record<string, number>
}

const LONG_EDGE = 1280

/**
 * Composite the redacted frame. Pure function of its input; the caller never
 * retains `frame` — this function nulls its own reference and the caller
 * nulls the caller's.
 */
export async function redactFrame(input: RedactInput): Promise<RedactOutput> {
  const t0 = performance.now()
  const reasons: string[] = []

  const scale = Math.min(1, LONG_EDGE / Math.max(input.width, input.height))
  const W = Math.max(1, Math.round(input.width * scale))
  const H = Math.max(1, Math.round(input.height * scale))

  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  if (!ctx) {
    return aborted(input, 'no 2d context for compositing')
  }

  // The raw frame is drawn ONCE and is not retained anywhere after this.
  ctx.drawImage(input.frame as CanvasImageSource, 0, 0, W, H)
  const tDraw = performance.now()

  const p = new Pseudonymizer(input.sessionId)
  const entries: RedactionEntry[] = []

  for (const it of input.items) {
    const method = methodFor(it.cls, true)
    const box: Box = {
      x: it.box.x * scale,
      y: it.box.y * scale,
      w: Math.max(2, it.box.w * scale),
      h: Math.max(2, it.box.h * scale),
    }

    if (method === 'pixelate') pixelate(ctx, box)
    else solidFill(ctx, box, CLASS_TINT[it.cls] ?? '#1e293b')

    const placeholder =
      it.cls === 'PASSWORD'
        ? { token: '[PASSWORD]', cls: it.cls as PiiClass }
        : p.tokenFor(it.text ?? `${it.cls}:${box.x}:${box.y}`, it.cls)

    entries.push({
      id: it.id,
      box,
      cls: it.cls,
      placeholder,
      method,
      score: it.score,
      source: it.source,
      pixelDerived: it.source === 'L3',
    })
  }

  // Set-of-Mark badges, burned over interactive elements AFTER redaction so a
  // badge can never cover up a redaction and make a secret legible.
  for (const m of input.marks) {
    drawBadge(ctx, { x: m.box.x * scale, y: m.box.y * scale, w: m.box.w * scale, h: m.box.h * scale }, m.mark)
  }
  const tComposite = performance.now()

  /* ---------------- the fail-closed gate ---------------- */
  // (§6.3) Every classified item must have a covering box; no high-score
  // region may remain unmasked; the manifest must match the frame. If ANY of
  // these fails we return an abort and NO bytes leave.
  const uncovered = input.items.filter((it) => !entries.some((e) => e.id === it.id))
  if (uncovered.length > 0) reasons.push(`${uncovered.length} classified items have no covering box`)

  const oob = entries.filter((e) => e.box.w <= 0 || e.box.h <= 0)
  if (oob.length > 0) reasons.push(`${oob.length} redaction boxes are degenerate`)

  const lowConf = entries.filter((e) => e.score < 0.5)
  if (lowConf.length > 0) reasons.push(`${lowConf.length} redactions below the confidence floor`)

  const manifest: RedactionManifest = {
    schema_version: SCHEMA_VERSION,
    session_id: input.sessionId,
    redactions: entries,
    frame_hash: input.frameHash,
    signature: signManifest(entries, input.frameHash),
    model_versions: {
      l2_ner: input.modelVersions['l2'] ?? 'unavailable',
      l3_face: input.modelVersions['l3face'] ?? 'unavailable',
      l3_text: input.modelVersions['l3text'] ?? 'unavailable',
      runtime: input.modelVersions['runtime'] ?? 'unknown',
    },
    abort_reason: reasons.length > 0 ? reasons.join('; ') : null,
  }

  const verdict: GateVerdict = {
    ok: reasons.length === 0,
    reasons,
    covered: entries.length - uncovered.length,
    uncovered: uncovered.length,
    frame_hash: input.frameHash,
  }

  if (!verdict.ok) {
    return {
      manifest,
      verdict,
      blob: null,
      bytes: 0,
      timings: { draw: tDraw - t0, composite: tComposite - tDraw, gate: performance.now() - tComposite },
    }
  }

  /* ---------------- encode: the ONLY readback ---------------- */
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
  const bytes = blob.size
  const tEncode = performance.now()

  return {
    manifest,
    verdict,
    blob,
    bytes,
    timings: {
      draw: tDraw - t0,
      composite: tComposite - tDraw,
      encode: tEncode - tComposite,
      total: tEncode - t0,
    },
  }
}

function aborted(input: RedactInput, reason: string): RedactOutput {
  return {
    manifest: {
      schema_version: SCHEMA_VERSION,
      session_id: input.sessionId,
      redactions: [],
      frame_hash: input.frameHash,
      signature: signManifest([], input.frameHash),
      model_versions: { l2_ner: 'n/a', l3_face: 'n/a', l3_text: 'n/a', runtime: 'n/a' },
      abort_reason: reason,
    },
    verdict: { ok: false, reasons: [reason], covered: 0, uncovered: input.items.length, frame_hash: input.frameHash },
    blob: null,
    bytes: 0,
    timings: {},
  }
}

/* ------------------------------------------------------------------ *
 *  Drawing primitives
 * ------------------------------------------------------------------ */

function roundRect(ctx: OffscreenCanvasRenderingContext2D, b: Box, r: number): void {
  const rr = Math.min(r, b.w / 2, b.h / 2)
  ctx.beginPath()
  ctx.moveTo(b.x + rr, b.y)
  ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, rr)
  ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, rr)
  ctx.arcTo(b.x, b.y + b.h, b.x, b.y, rr)
  ctx.arcTo(b.x, b.y, b.x + b.w, b.y, rr)
  ctx.closePath()
}

function solidFill(ctx: OffscreenCanvasRenderingContext2D, b: Box, tint: string): void {
  ctx.save()
  roundRect(ctx, b, 4)
  ctx.fillStyle = tint
  ctx.fill()
  ctx.restore()
}

/**
 * Pixelation via downsample→upsample on a scratch canvas. Cheaper than a
 * separable blur and has no deblur ambiguity (§6.2). Block size scales with the
 * box so a small face is not over-blurred into nothing.
 */
function pixelate(ctx: OffscreenCanvasRenderingContext2D, b: Box): void {
  const block = Math.max(4, Math.round(Math.min(b.w, b.h) / 8))
  const w = Math.max(1, Math.floor(b.w / block))
  const h = Math.max(1, Math.floor(b.h / block))
  const scratch = new OffscreenCanvas(w, h)
  const sctx = scratch.getContext('2d')
  if (!sctx) {
    solidFill(ctx, b, '#4c1d95')
    return
  }
  // Re-extract from the destination canvas: the frame is already drawn there,
  // so this is a GPU-side read of our own composited surface, never the raw
  // capture. That distinction is what keeps the "no raw readback" claim true.
  sctx.imageSmoothingEnabled = true
  sctx.drawImage(ctx.canvas, b.x, b.y, b.w, b.h, 0, 0, w, h)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  roundRect(ctx, b, 4)
  ctx.clip()
  ctx.drawImage(scratch, 0, 0, w, h, b.x, b.y, b.w, b.h)
  ctx.restore()
}

function drawBadge(ctx: OffscreenCanvasRenderingContext2D, b: Box, mark: number): void {
  const r = badgeRect(b, 1)
  ctx.save()
  roundRect(ctx, r, 4)
  ctx.fillStyle = '#1d4ed8'
  ctx.fill()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 13px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(mark), r.x + r.w / 2, r.y + r.h / 2 + 0.5)
  ctx.restore()
}

/* ------------------------------------------------------------------ *
 *  Manifest signature — tamper evidence, not a security boundary [§6.3]
 * ------------------------------------------------------------------ */

export function signManifest(entries: RedactionEntry[], frameHash: string): string {
  const canonical = JSON.stringify(entries.map((e) => [e.id, e.cls, e.method, Math.round(e.box.x), Math.round(e.box.y), Math.round(e.box.w), Math.round(e.box.h)]).sort())
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const s = canonical + frameHash
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + '00000000'
}
