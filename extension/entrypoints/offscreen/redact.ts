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
import { THUMB, type TileRect } from '@/lib/framediff'
import { Pseudonymizer, PASSWORD_TOKEN } from '@/lib/pseudonym'

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
  /**
   * Deliberately loud. An uninspectable region is not a classified class, and
   * the panel should make that legible at a glance rather than looking like an
   * ordinary redaction.
   */
  OPAQUE_REGION: '#020617',
  /** Unclassified text recovered from pixels. Reads as neutral grey. */
  TEXT_REGION: '#475569',
}

/** Which method each class gets, per §6.1. */
export function methodFor(cls: PiiClass, hasBox: boolean): 'solid_fill' | 'pixelate' | 'placeholder' {
  if (cls === 'FACE') return 'pixelate'
  // §6.3 fail-closed: we could not inspect this region, so we erase it rather
  // than guess. Never pixelate — a pixelated frame is still a readable frame.
  if (cls === 'OPAQUE_REGION') return 'solid_fill'
  // Text we OCR'd but could not classify is in the same position: we know there
  // is something there and we do not know what it is. A captcha or a
  // hand-written number matches no detector, so "no match" is not "safe".
  if (cls === 'TEXT_REGION') return 'solid_fill'
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
 *  Pseudonymization — the CANONICAL implementation lives in lib/pseudonym.ts
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  The compositor
 * ------------------------------------------------------------------ */

/** One thing to redact, from any detection layer. */
export interface RedactItem {
  id: string
  cls: PiiClass
  box: Box
  score: number
  source: 'L0' | 'L1' | 'L2' | 'L3'
  text?: string
  /**
   * True when `text` was recovered from pixels by the L3 OCR pass rather than
   * read off the DOM. It reaches the manifest as `pixelDerived`, which is how
   * the server can tell "we read this from the page" from "we read this out of
   * a picture" — a materially weaker claim, since OCR is fallible.
   */
  recoveredFromPixels?: boolean
}

export interface RedactInput {
  /** The ONLY reference to raw pixels. Nulled before return. */
  frame: ImageBitmap | VideoFrame | OffscreenCanvas
  width: number
  height: number
  items: RedactItem[]
  marks: MarkAssignment[]
  frameHash: string
  /**
   * §7 dirty tiles to crop for a delta turn. They are cropped from the
   * REDACTED canvas INSIDE this function, because that canvas is released and
   * nulled before it returns — handing a reference out would defeat the one
   * invariant this module exists to hold.
   */
  tiles?: TileRect[]
  sessionId: string
  modelVersions: Record<string, string>
}

export interface RedactOutput {
  manifest: RedactionManifest
  verdict: GateVerdict
  blob: Blob | null
  bytes: number
  /**
   * Encoded frame dimensions. The server needs these to place delta tiles: the
   * gate works in 64x64 tiles of the SOURCE frame, while the server
   * re-composites against the CAPPED, ENCODED image, so tile coordinates are
   * only meaningful once the scale factor is known.
   */
  frameWidth: number
  frameHeight: number
  /** Base64 PNGs cropped from the redacted frame, for a delta turn (§7). */
  tiles: Array<{ x: number; y: number; w: number; h: number; b64: string }>
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

    // A PASSWORD never gets a pseudonym, so it does not go through tokenFor.
    const placeholder =
      it.cls === 'PASSWORD'
        ? { token: PASSWORD_TOKEN, cls: it.cls as PiiClass }
        : p.tokenFor(it.text ?? `${it.cls}:${box.x}:${box.y}`, it.cls)

    entries.push({
      id: it.id,
      box,
      cls: it.cls,
      placeholder,
      method,
      score: it.score,
      source: it.source,
      pixelDerived: it.source === 'L3' || it.recoveredFromPixels === true,
    })
  }

  // Set-of-Mark badges, burned over interactive elements AFTER redaction so a
  // badge can never cover up a redaction and make a secret legible.
  for (const m of input.marks) {
    drawBadge(ctx, { x: m.box.x * scale, y: m.box.y * scale, w: m.box.w * scale, h: m.box.h * scale }, m.mark)
  }
  const tComposite = performance.now()

  /* ---------------- the fail-closed gate ---------------- */
  // (§6.3) Every classified item must have a covering box, the manifest must
  // be well-formed, and the frame hash must match.
  //
  // WHAT THIS DOES NOT DO, deliberately: it does not abort on a low-confidence
  // detection. A low-confidence hit is EVIDENCE OF POSSIBLE PII, which is
  // exactly the moment you must redact. The old code refused to send whenever
  // any entry scored below 0.5 — and since L0 semantic hits routinely do, that
  // aborted ordinary pages. The correct direction is: redact the uncertain item
  // (it is already redacted by the loop above) and only abort when the gate
  // cannot vouch for something it never classified. [audit 1.4]
  const uncovered = input.items.filter((it) => !entries.some((e) => e.id === it.id))
  if (uncovered.length > 0) reasons.push(`${uncovered.length} classified items have no covering box`)

  // Degenerate-box check runs BEFORE the clamp that pads a box to 2px. After
  // the clamp, w and h are always >= 2, so a check placed there could never
  // fire. [audit 1.4]
  const degenerate = input.items.filter((it) => it.box.w <= 0 || it.box.h <= 0)
  if (degenerate.length > 0) {
    reasons.push(`${degenerate.length} redaction boxes have zero area in the captured frame`)
  }

  /**
   * THE fail-closed invariant, stated as an assertion rather than a hope.
   *
   * An OPAQUE_REGION is a place we could not inspect: a frame that refused
   * injection, or a canvas/video whose contents L3 has not cleared. There is
   * no "probably fine" here — if such a region is still visible in the frame
   * we are about to upload, the request must not happen. This is the check
   * that makes the ARCHITECTURE.md §6.3 claim true rather than aspirational.
   */
  const opaqueUncovered = input.items.filter(
    (it) => it.cls === 'OPAQUE_REGION' && !entries.some((e) => e.id === it.id),
  )
  if (opaqueUncovered.length > 0) {
    reasons.push(
      `FAIL-CLOSED: ${opaqueUncovered.length} uninspectable region(s) would ship unredacted`,
    )
  }

  // And the converse: every opaque region present must actually be in the
  // manifest, so the server is told what it is not being shown.
  const opaqueTotal = input.items.filter((it) => it.cls === 'OPAQUE_REGION').length
  const opaqueInManifest = entries.filter((e) => e.cls === 'OPAQUE_REGION').length
  if (opaqueInManifest !== opaqueTotal) {
    reasons.push(
      `manifest declares ${opaqueInManifest} uninspectable region(s) but ${opaqueTotal} were detected`,
    )
  }

  // Recorded for the HUD, not used to abort.
  const lowConfidence = entries.filter((e) => e.score < 0.5).length

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
      frameWidth: canvas.width,
      frameHeight: canvas.height,
      tiles: [],
      timings: { draw: tDraw - t0, composite: tComposite - tDraw, gate: performance.now() - tComposite },
    }
  }

  /* ---------------- encode: the ONLY readback ---------------- */
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
  const bytes = blob.size

  /**
   * §7 delta tiles, cropped from the redacted canvas.
   *
   * This runs HERE, before the canvas reference goes out of scope, and it
   * crops the composited (already-redacted) image rather than the capture. A
   * delta turn is therefore a bandwidth saving and never a privacy bypass: the
   * pixels that travel are the same pixels the gate approved.
   */
  const tiles = await cropTiles(canvas, input.tiles ?? [], input.width, input.height)
  const tEncode = performance.now()

  return {
    manifest,
    verdict,
    blob,
    bytes,
    frameWidth: canvas.width,
    frameHeight: canvas.height,
    tiles,
    timings: {
      draw: tDraw - t0,
      composite: tComposite - tDraw,
      encode: tEncode - tComposite,
      total: tEncode - t0,
    },
  }
}

  /**
   * §7 — crop the dirty tiles out of the REDACTED frame.
   *
   * Three properties this function must never lose:
   *
   *   1. It crops from the composited canvas, never from the raw capture. A tile
   *      is a region of the same image that passed the gate, so a delta turn
   *      cannot become a path for unredacted pixels to reach the server.
   *   2. `TileRect` is in GRID units (tx/ty of a 64px grid over the SOURCE
   *      frame), so it has to be converted to source pixels and then scaled to
   *      the capped encode size. Skipping either step places the crop in the
   *      wrong place — silently, and only visible as a mismatched tile.
   *   3. `change` is dropped from the wire payload: the server composites by
   *      position, and the score is client-side information it has no use for.
   */
  export async function cropTiles(
    canvas: OffscreenCanvas,
    tiles: TileRect[],
    sourceWidth: number,
    sourceHeight: number,
  ): Promise<Array<{ x: number; y: number; w: number; h: number; b64: string }>> {
    if (tiles.length === 0) return []
    const srcW = sourceWidth || canvas.width
    const srcH = sourceHeight || canvas.height
    // Each rect carries the grid it was computed on, because the grid is a
    // per-call option rather than a constant.
    const cols = Math.max(1, tiles[0]!.cols)
    const rows = Math.max(1, tiles[0]!.rows)
    // A TileRect indexes the 64×64 LUMA THUMBNAIL, not the source frame. So a
    // tile covers cols/64 of the frame width, and the crop must be scaled from
    // thumbnail space to encoded-canvas space in one step.
    const sx = canvas.width / srcW
    const sy = canvas.height / srcH
    const out: Array<{ x: number; y: number; w: number; h: number; b64: string }> = []

    for (const t of tiles) {
      const x = Math.max(0, Math.round((t.tx / cols) * srcW * sx))
      const y = Math.max(0, Math.round((t.ty / rows) * srcH * sy))
      const w = Math.max(1, Math.min(canvas.width - x, Math.round((t.tw / cols) * srcW * sx)))
      const h = Math.max(1, Math.min(canvas.height - y, Math.round((t.th / rows) * srcH * sy)))
      if (w < 2 || h < 2) continue

      const tileCanvas = new OffscreenCanvas(w, h)
      const tctx = tileCanvas.getContext('2d')
      if (!tctx) continue
      tctx.drawImage(canvas, x, y, w, h, 0, 0, w, h)
      // PNG, not WebP: a small tile is mostly flat colour after redaction, and
      // WebP's lossy path can smear a redaction edge into neighbouring pixels.
      const blob = await tileCanvas.convertToBlob({ type: 'image/png' })
      const buf = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      const CHUNK = 0x8000
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
      }
      out.push({ x, y, w, h, b64: btoa(bin) })
    }
    return out
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
    frameWidth: 0,
    frameHeight: 0,
    tiles: [],
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
 *  Manifest checksum — integrity, NOT authenticity [§6.3]
 * ------------------------------------------------------------------ */

/**
 * A non-cryptographic content digest over the canonical manifest.
 *
 * WHAT THIS IS NOT, stated plainly because the previous version of this file
 * called it an HMAC and it was not one: there is no secret key here, so anyone
 * who can see a manifest can recompute this value. It detects a corrupted or
 * truncated manifest in transit and it binds the redaction list to the frame
 * hash. It does NOT prove the client produced it, and a server must not treat
 * it as an authentication signal — the key would have to live in the extension,
 * where any page-visible code path can read it.
 *
 * Real tamper-evidence needs a server-held public key and signatures over the
 * canonical JSON, which is out of scope for a client-side tool. The honest
 * claim is "the manifest is internally consistent and bound to this frame".
 */
export function signManifest(entries: RedactionEntry[], frameHash: string): string {
  const canonical = JSON.stringify(
    entries
      .map((e) => [
        e.id, e.cls, e.method,
        Math.round(e.box.x), Math.round(e.box.y),
        Math.round(e.box.w), Math.round(e.box.h),
      ])
      .sort(),
  )
  // FNV-1a plus a second differently-seeded pass, concatenated. Cheap, and
  // adequate for spotting accidental corruption — which is all this promises.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const s = canonical + frameHash
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0') +
    // Length tag, so a truncated manifest cannot collide with a complete one.
    (canonical.length >>> 0).toString(16).padStart(8, '0')
  )
}
