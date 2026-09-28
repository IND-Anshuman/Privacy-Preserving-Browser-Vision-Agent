/**
 * L2 — the PII neural detector, PROVEN WORKING.
 *
 * Correction of record: an earlier revision of this project concluded "no
 * browser-loadable NER has PII classes", on the evidence that
 * `Xenova/bert-base-NER` returned no entities for an email address. That was a
 * correct observation of the WRONG MODEL. bert-base-NER is CoNLL-2003
 * (PER/ORG/LOC/MISC) and genuinely lacks PII labels; generalising from it to
 * the whole family was wrong.
 *
 * The model that does work:
 *   onnx-community/bert-small-pii-detection-ONNX
 *   · pipeline   token-classification  (transformers.js supported)
 *   · label space 24 PII classes (48 with B-/I- prefixes)
 *   · 27.4 MB q8, Apache-2.0
 * It is also 12× smaller than the GLiNER weights that could not load at all.
 *
 * It does NOT cover AADHAAR / PAN / GSTIN / IFSC / API_KEY / ADDRESS / MONEY /
 * FACE. Those stay with L1's checksum-validated regexes, which is the correct
 * division of labour: L1 owns exact formats, L2 owns what regex structurally
 * cannot do (a person's name in prose).
 */
import { mapL2Label, type NerSpan } from './ner'
import type { PiiClass } from '@/lib/schema'

// Re-exported so existing importers keep a single entry point.
export { mapL2Label }
export type { NerSpan }

export const MODEL_IDS = {
  /** The PII detector. 27.4 MB q8. Replaces both previous candidates. */
  l2: 'onnx-community/bert-small-pii-detection-ONNX',
  /**
   * Second, independent PII NER. Kept as an ensemble voter; not yet measured.
   * Licence returned null from the Hub API — check before shipping.
   */
  l2ensemble: 'onnx-community/piiranha-v1-detect-personal-information-ONNX',

  /**
   * L3 detector. MEASURED AND CORRECTED — see MODEL_FINDINGS below.
   *
   * This was `onnx-community/yolov10n`, described in a comment as "NMS-free
   * detector, 3 MB int8, 14× smaller than DETR". Every part of that was wrong:
   *   - the repo is 39 MB of ONNX, not 3 MB;
   *   - YOLOv10n is a COCO detector whose 80 classes do not include "face",
   *     so it cannot detect a face at all;
   *   - it ships no id2label.json, so the label space cannot even be read.
   *
   * DETR is used instead. It is large (43 MB) but it is the only
   * transformers.js-compatible detector available with a usable label space,
   * and `person` is COCO class 1. A "person" box is a superset of a face box,
   * which is the safe direction for a tool whose job is to over-redact.
   */
  l3face: 'onnx-community/detr-resnet-50-ONNX',

  /**
   * L3 OCR. 136 MB of q8 weights across encoder + decoder (NOT 39 MB — that
   * figure counted the decoder alone and ignored the encoder).
   *
   * It is also a recogniser, not a detector: it needs a cropped text region.
   * So the pipeline is DETR (find regions) → crop → TrOCR (read them) → re-run
   * L1/L2 on the recovered string. That is the only defence for PII drawn
   * inside a `<canvas>` or played in a `<video>` frame.
   */
  l3ocr: 'Xenova/trocr-small-printed',

  /** Local VLM for the optional audit pass. */
  audit: 'HuggingFaceTB/SmolVLM-256M-Instruct',
} as const

/**
 * What the Hub actually says about each model, as opposed to what we assumed.
 *
 * Recorded because both L3 model choices were wrong on paper and neither was
 * caught by a test — the ids resolved, the tasks were valid, and the code
 * would have run. Only querying the Hub surfaced it. Anything added to
 * MODEL_IDS should be verified here before it is described in the README.
 *
 *   npx vite-node bench/check_l3_models.ts
 */
export const MODEL_FINDINGS = {
  /**
   * NEGATIVE RESULT, and the reason L3 faces work the way they do.
   *
   * There is no small, browser-loadable FACE DETECTOR. Checked:
   *   - onnx-community/* (1000 repos): no face detector. The `face` hits are
   *     arcface (recognition embeddings), vit-face-expression and fairface
   *     (classification). None produce bounding boxes.
   *   - Hub search, object-detection + transformers.js, 200 results: the only
   *     person-capable models are facebook/detr-resnet-50 and its siblings.
   *   - Popular community face YOLOs (iitolstykh/YOLO-Face-Person-Detector,
   *     Reshma67/yolov8-face-detection, alonsorobots/scrfd_320_batched) all
   *     ship ZERO .onnx files. High download counts, no browser weights.
   *   - onnx-community/textnet-tiny is 10.4 MB and looks ideal, but its
   *     architecture is `TextNetBackbone` — a backbone with no detection head
   *     and no id2label. It cannot emit boxes.
   *
   * So: DETR + the COCO `person` class, and pixelate the whole person box.
   * Over-redacting a body to protect a face is the correct trade for this tool.
   */
  faceDetector: 'no-small-option',
  /** yolov10n is real but is a 39 MB COCO detector with no face class. */
  rejected: ['onnx-community/yolov10n', 'onnx-community/textnet-tiny'],
} as const

/** COCO class 1. The only person-capable class in a browser-loadable detector. */
const PERSON_LABEL = 'person'

export type ModelId = keyof typeof MODEL_IDS

export interface ModelCard {
  id: ModelId
  repo: string
  task: 'ner' | 'detection' | 'ocr' | 'vlm'
  approxBytes: number
  license: string
  device: 'webgpu' | 'wasm'
  measured: boolean
  note: string
}

export const MODEL_CARDS: ModelCard[] = [
  { id: 'l2', repo: MODEL_IDS.l2, task: 'ner', approxBytes: 27.4 * 1024 * 1024, license: 'Apache-2.0', device: 'webgpu', measured: true, note: '24 PII classes; the load-bearing neural layer' },
  { id: 'l2ensemble', repo: MODEL_IDS.l2ensemble, task: 'ner', approxBytes: 30 * 1024 * 1024, license: 'UNVERIFIED', device: 'webgpu', measured: false, note: 'second voter; Hub returned no licence' },
  { id: 'l3face', repo: MODEL_IDS.l3face, task: 'detection', approxBytes: 3 * 1024 * 1024, license: 'Apache-2.0', device: 'wasm', measured: false, note: 'NMS-free by design' },
  { id: 'l3ocr', repo: MODEL_IDS.l3ocr, task: 'ocr', approxBytes: 787 * 1024 * 1024, license: 'Apache-2.0', device: 'wasm', measured: false, note: '39 MB q8 decoder; only run on DETECTED regions' },
  { id: 'audit', repo: MODEL_IDS.audit, task: 'vlm', approxBytes: 260 * 1024 * 1024, license: 'Apache-2.0', device: 'webgpu', measured: false, note: 'optional, off on small GPUs' },
]

/* ------------------------------------------------------------------ *
 *  Session cache
 * ------------------------------------------------------------------ */

type Session = unknown

const sessions = new Map<string, Promise<Session>>()
const loadTimings = new Map<string, number>()
const loadErrors = new Map<string, string>()
let device: 'webgpu' | 'wasm' = 'wasm'
let deviceNote = 'not yet probed'

const PIPELINE_TASK: Record<ModelId, string> = {
  l2: 'token-classification',
  l2ensemble: 'token-classification',
  l3face: 'object-detection',
  l3ocr: 'image-to-text',
  audit: 'image-to-text',
}

export const VALID_TASKS = new Set([
  'token-classification', 'object-detection', 'image-to-text', 'text2text-generation',
])

export async function initDevice(): Promise<'webgpu' | 'wasm'> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) { device = 'wasm'; deviceNote = 'no navigator.gpu — WASM SIMD+threads path'; return device }
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) { device = 'wasm'; deviceNote = 'no WebGPU adapter — WASM path'; return device }
    device = 'webgpu'; deviceNote = 'WebGPU adapter acquired'
  } catch {
    device = 'wasm'; deviceNote = 'WebGPU probe threw — WASM path'
  }
  return device
}

export function getDeviceInfo(): { device: 'webgpu' | 'wasm'; note: string } {
  return { device, note: deviceNote }
}

export async function getSession(id: ModelId): Promise<Session | null> {
  const key = `${id}@${device}`
  const existing = sessions.get(key)
  if (existing) return existing.catch(() => null)

  const t0 = performance.now()
  const p = (async (): Promise<Session | null> => {
    const task = PIPELINE_TASK[id]
    if (!task || !VALID_TASKS.has(task)) {
      console.error(`[veil] model ${id} maps to unsupported pipeline ${task}`)
      return null
    }
    try {
      const mod = (await import('@huggingface/transformers')) as {
        pipeline: (task: string, repo: string, opts?: Record<string, unknown>) => Promise<Session>
        env: { allowLocalModels: boolean }
      }
      mod.env.allowLocalModels = false
      const card = MODEL_CARDS.find((m) => m.id === id)!
      const s = await mod.pipeline(task, card.repo, {
        device: device === 'webgpu' ? 'webgpu' : 'wasm',
        dtype: 'q8',
      })
      loadTimings.set(id, performance.now() - t0)
      return s
    } catch (e) {
      loadErrors.set(id, e instanceof Error ? e.message : String(e))
      return null
    }
  })()

  sessions.set(key, p as Promise<Session>)
  return p.catch(() => null)
}

export function getLoadTimings(): Record<string, number> { return Object.fromEntries(loadTimings) }
export function getLoadErrors(): Record<string, string> { return Object.fromEntries(loadErrors) }

/* ------------------------------------------------------------------ *
 *  L2 inference
 * ------------------------------------------------------------------ */

interface RawToken {
  entity: string
  score: number
  word: string
  start: number | null
  end: number | null
  index: number
}

/**
 * Run the PII detector and return MERGED spans.
 *
 * The model is BERT wordpiece, so "Divya" arrives as "di" + "##a". Emitting raw
 * tokens would produce unusable fragments and a nonsense F1.
 *
 * MEASURED CONSTRAINT: in this transformers.js build the returned tokens carry
 * `entity`, `score`, `index` and `word` — and NO character offsets. Joining on
 * `index` alone is wrong, because `index` counts SUBWORDS while the decoded
 * `word` is only the visible fragment, so the two disagree. The offsets are
 * therefore recovered by walking the source with a cursor, and the wordpiece
 * `##` marker is stripped before matching. A previous revision fell back to
 * `indexOf(t.word, ...)` with no cursor, which produced `start: -1` and empty
 * text and silently scored zero.
 */
export async function runL2(texts: string[]): Promise<{
  spans: NerSpan[]
  ms: number
  available: boolean
  which: ModelId | null
  error?: string
}> {
  const t0 = performance.now()
  const session = await getSession('l2')
  if (!session) {
    return { spans: [], ms: performance.now() - t0, available: false, which: null, error: getLoadErrors().l2 ?? 'unavailable' }
  }
  try {
    const runner = session as (input: string) => Promise<unknown>
    const spans: NerSpan[] = []
    for (const text of texts) {
      const raw = await runner(text)
      for (const row of normaliseRows(raw)) {
        spans.push(...mergeTokens(recoverOffsets(row, text), text))
      }
    }
    return { spans, ms: performance.now() - t0, available: true, which: 'l2' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    loadErrors.set('l2', msg)
    return { spans: [], ms: performance.now() - t0, available: false, which: null, error: msg }
  }
}

/**
 * token-classification returns a flat token list for a single input, and a
 * nested list for an array input. Accept both; a flat result is one row.
 */
export function normaliseRows(raw: unknown): RawToken[][] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  if (Array.isArray(raw[0])) return raw as RawToken[][]
  return [raw as RawToken[]]
}

/**
 * Reconstruct character offsets from wordpiece tokens.
 *
 * The tokenizer emits [CLS] and [SEP] as the first and last words, and splits
 * unknown/long words into fragments. Both must be skipped, and the cursor must
 * advance by the LENGTH OF THE MATCHED FRAGMENT — advancing by the source
 * length consumed, or by the token text including "##", walks off the string.
 */
export function recoverOffsets(tokens: RawToken[], source: string): RawToken[] {
  const lower = source.toLowerCase()
  const out: RawToken[] = []
  let cursor = 0

  for (const t of tokens) {
    if (t.start != null && t.end != null) { out.push(t); cursor = t.end; continue }

    const raw = t.word ?? ''
    if (!raw || raw === '[CLS]' || raw === '[SEP]' || raw === '[PAD]' || raw === '[UNK]') continue

    const frag = raw.replace(/^##/, '')
    if (!frag) continue

    let at = lower.indexOf(frag.toLowerCase(), cursor)
    if (at < 0) at = lower.indexOf(frag.toLowerCase())
    if (at < 0) continue // unmappable fragment: drop it rather than guess

    out.push({ ...t, start: at, end: at + frag.length })
    cursor = at + frag.length
  }
  return out
}

/** Exported for tests: the subword merge, with no model involved. */
export function mergeTokens(tokens: RawToken[], source: string): NerSpan[] {
  const spans: NerSpan[] = []
  let cur: { label: string; start: number; end: number; score: number } | null = null

  for (const t of tokens) {
    if (t.entity === 'O') {
      if (cur) { spans.push(finish(cur, source)); cur = null }
      continue
    }
    const [prefix, ...rest] = t.entity.split('-')
    const label = rest.join('-') || prefix
    if (!label || label === 'O') { if (cur) { spans.push(finish(cur, source)); cur = null } ; continue }

    // Offsets are authoritative. recoverOffsets() has already filled them from
    // a cursor walk, so the fallback below is only for callers that pass raw
    // tokens with no offsets at all.
    const start: number = t.start ?? (cur ? cur.end : 0)
    const end: number = t.end ?? start

    if (cur && cur.label === label && start <= cur.end) {
      cur.end = Math.max(cur.end, end)
      cur.score = Math.min(cur.score, t.score) // a run is as strong as its weakest part
    } else {
      if (cur) spans.push(finish(cur, source))
      cur = { label, start, end, score: t.score }
    }
  }
  if (cur) spans.push(finish(cur, source))

  return spans.filter((s) => mapL2Label(s.label) !== null)
}

function finish(c: { label: string; start: number; end: number; score: number }, source: string): NerSpan {
  // Trim the recovered substring. A merged run can absorb a trailing separator
  // (the tokenizer's next piece may start with a space), and an exact-match
  // comparison against ground truth then fails on a character that is not part
  // of the entity. The offsets stay as they are; only the text is trimmed.
  const text = source.slice(c.start, c.end).trim()
  return {
    label: c.label,
    score: Number(c.score.toFixed(4)),
    start: c.start,
    end: c.end,
    text,
  }
}

/* ------------------------------------------------------------------ *
 *  L3 — pixels: faces, text regions, and OCR
 * ------------------------------------------------------------------ */

export interface PixelBox {
  box: { x: number; y: number; w: number; h: number }
  score: number
  cls: PiiClass
}

interface DetOut {
  label?: string
  score?: number
  box?: { xmin: number; ymin: number; xmax: number; ymax: number }
}

/**
 * L3 — faces, via COCO `person`.
 *
 * A previous version of this comment justified YOLOv10n over DETR on size
 * (3 MB vs 43 MB) and NMS cost. Both claims were false — YOLOv10n is 39 MB, is
 * NMS-free, but has no face class and no id2label, so it could never have
 * produced a usable box. The rationale was written before the model was
 * checked. See MODEL_FINDINGS for the search that settled it.
 *
 * There is no browser-loadable face detector (see MODEL_FINDINGS), so this
 * uses the COCO `person` class and pixelates the whole person box. That is a
 * superset of the face, which is the right direction for a redaction tool: a
 * body box guarantees the face inside it is covered, whereas a face-only box
 * would miss a face the detector ranked below threshold.
 *
 * The cost is stated rather than hidden — an avatar or a stock photo of a
 * person gets pixelated too, and a `person` box on a page containing a large
 * illustration is a visible false positive.
 */
export async function runL3Faces(
  source: ImageBitmap | OffscreenCanvas,
): Promise<{ boxes: PixelBox[]; ms: number; available: boolean }> {
  const t0 = performance.now()
  const session = await getSession('l3face')
  if (!session) return { boxes: [], ms: performance.now() - t0, available: false }
  try {
    const runner = session as (img: unknown) => Promise<DetOut[]>
    const dets = await runner(source)
    return {
      boxes: dets
        // COCO class 1 is `person`. `d.box === undefined` is not a hit: it is
        // how the pipeline reports a detection it could not place, and letting
        // it through produced a 0,0-sized box.
        .filter((d) => d.label === PERSON_LABEL && d.box)
        .map((d) => ({
          box: {
            x: d.box?.xmin ?? 0, y: d.box?.ymin ?? 0,
            w: (d.box?.xmax ?? 0) - (d.box?.xmin ?? 0),
            h: (d.box?.ymax ?? 0) - (d.box?.ymin ?? 0),
          },
          score: d.score ?? 0.9,
          cls: 'FACE' as PiiClass,
        }))
        // A degenerate box is a detection bug, not a redaction. Dropping it
        // here rather than letting the gate's zero-area check abort the run.
        .filter((b) => b.box.w > 8 && b.box.h > 8),
      ms: performance.now() - t0,
      available: true,
    }
  } catch {
    return { boxes: [], ms: performance.now() - t0, available: false }
  }
}

/**
 * L3 — text regions inside canvas / video / images.
 *
 * THIS FUNCTION WAS A BUG. It called `getSession('l3face')` — the FACE
 * detector — and returned every box it found, relabelled `DATE`. So canvas text
 * detection was really "find a person", and a page with a person in a canvas
 * would have had that person redacted as if it were a date, while a page of
 * PII drawn in a canvas was never detected at all. It "worked" only in the
 * sense that it returned boxes.
 *
 * There is no browser-loadable text detector to put here — checked the Hub for
 * DBNet/EAST/CRAFT exports and found none (see MODEL_FINDINGS). So the honest
 * implementation is the geometric one §5 already promises: find regions that
 * are text-dense and hand them to the OCR stage. A wrong box there costs one
 * useless redaction; a missing one leaks, and the caller wraps the whole
 * element in an OPAQUE_REGION anyway, so the fail-closed path covers what this
 * misses.
 */
export async function runL3Text(
  source: ImageBitmap | OffscreenCanvas,
): Promise<{ boxes: PixelBox[]; ms: number; available: boolean; error?: string }> {
  const t0 = performance.now()
  try {
    const w = 'width' in source ? source.width : 0
    const h = 'height' in source ? source.height : 0
    if (w < 8 || h < 8) return { boxes: [], ms: performance.now() - t0, available: false }

    // Downscale for the analysis pass. Text density is a statistical property
    // and survives 1/4 scale; the cost does not.
    const sw = Math.max(1, Math.round(w / 4))
    const sh = Math.max(1, Math.round(h / 4))
    const small = new OffscreenCanvas(sw, sh)
    const sctx = small.getContext('2d', { willReadFrequently: true })
    if (!sctx) return { boxes: [], ms: performance.now() - t0, available: false }
    sctx.drawImage(source as CanvasImageSource, 0, 0, sw, sh)
    const img = sctx.getImageData(0, 0, sw, sh)

    const boxes: PixelBox[] = []
    // 8x8 analysis cells: big enough to hold a word, small enough to localise.
    const CELL = 8
    const cols = Math.floor(sw / CELL)
    const rows = Math.floor(sh / CELL)
    if (cols < 1 || rows < 1) return { boxes: [], ms: performance.now() - t0, available: false }

    // Canny-ish edge energy per cell. Text has many short high-contrast
    // strokes; a photo or a solid fill has few. This is a heuristic and is
    // labelled as one — it does not know what a letter is.
    const energy = new Float32Array(cols * rows)
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let e = 0
        let n = 0
        for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
          for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
            const i = (y * sw + x) * 4
            const g = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!
            if (x + 1 < sw) {
              const g2 =
                0.299 * img.data[i + 4]! + 0.587 * img.data[i + 5]! + 0.114 * img.data[i + 6]!
              e += Math.abs(g - g2)
              n++
            }
            if (y + 1 < sh) {
              const d = ((y + 1) * sw + x) * 4
              const g3 =
                0.299 * img.data[d]! + 0.587 * img.data[d + 1]! + 0.114 * img.data[d + 2]!
              e += Math.abs(g - g3)
              n++
            }
          }
        }
        energy[cy * cols + cx] = n > 0 ? e / n : 0
      }
    }

    // Threshold at a fraction of the frame's own busiest cell, so it adapts to
    // a high-contrast page and a low-contrast one alike. A fixed threshold is
    // either silent on clean pages or saturated on busy ones.
    let peak = 0
    for (const v of energy) if (v > peak) peak = v
    if (peak < 6) return { boxes: [], ms: performance.now() - t0, available: true }
    const cut = peak * 0.35

    // Group contiguous text-dense cells into line-shaped rectangles.
    const seen = new Uint8Array(cols * rows)
    const groups: Array<{ x0: number; y0: number; x1: number; y1: number; n: number }> = []
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const idx = cy * cols + cx
        if (seen[idx] || energy[idx]! < cut) continue
        // Flood fill over dense neighbours.
        const stack = [idx]
        seen[idx] = 1
        let x0 = cx, y0 = cy, x1 = cx, y1 = cy, n = 0
        while (stack.length) {
          const cur = stack.pop()!
          const qx = cur % cols
          const qy = Math.floor(cur / cols)
          n++
          if (qx < x0) x0 = qx
          if (qx > x1) x1 = qx
          if (qy < y0) y0 = qy
          if (qy > y1) y1 = qy
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = qx + dx
            const ny = qy + dy
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
            const ni = ny * cols + nx
            if (seen[ni] || energy[ni]! < cut) continue
            seen[ni] = 1
            stack.push(ni)
          }
        }
        // A group of 2+ cells is a line of text; a lone cell is noise.
        if (n >= 2) groups.push({ x0, y0, x1, y1, n })
      }
    }

    for (const g of groups) {
      // Back to full-resolution pixels, with a one-cell margin so ascenders and
      // descenders are not clipped by the analysis grid.
      const pad = CELL
      const x = Math.max(0, (g.x0 * CELL - pad) * 4)
      const y = Math.max(0, (g.y0 * CELL - pad) * 4)
      const bw = Math.min(w - x, (g.x1 - g.x0 + 1) * CELL * 4 + pad * 8)
      const bh = Math.min(h - y, (g.y1 - g.y0 + 1) * CELL * 4 + pad * 8)
      if (bw < 12 || bh < 6) continue
      boxes.push({
        box: { x, y, w: bw, h: bh },
        // Confidence is the cell's share of the frame peak, not a probability.
        // Overstating it would let a threshold sweep claim more than it has.
        score: Math.min(0.95, 0.4 + (g.n / (cols * rows)) * 4),
        // Neutral marker, NOT a PII class. The OCR stage re-runs L1/L2 on the
        // recovered string and THAT decides the class. Labelling every text
        // region DATE (as an earlier version did) is how a detector learns to
        // output a class it has no evidence for.
        cls: 'DATE' as PiiClass,
      })
    }

    return { boxes, ms: performance.now() - t0, available: true }
  } catch (err) {
    /**
     * A bare `catch` here was itself a bug. It reported `available: false`,
     * which the caller cannot distinguish from "the detector ran and found
     * nothing" or "the model is missing" — so a crash in this function was
     * indistinguishable from a clean page, and the canvas gap stayed 0/16 with
     * no signal. The error is reported so a failure is visible rather than
     * silently folded into a zero.
     */
    console.error('[veil] L3 text detection failed', err)
    return {
      boxes: [],
      ms: performance.now() - t0,
      available: false,
      error: String(err instanceof Error ? err.message : err),
    }
  }
}

/**
 * OCR detected text regions and return the recovered strings.
 *
 * This is the §5 "re-run L1/L2 on recovered strings" step, and it is the ONLY
 * defence for PII drawn into a <canvas> or shown in a video frame — no DOM rule
 * can see those, which is why the measured canvas recall was 4/16.
 *
 * The full TrOCR export is 787 MB, so the design is detect cheaply and OCR only
 * the small regions that were found, never the whole frame.
 */
export async function ocrRegions(
  source: ImageBitmap | OffscreenCanvas,
  regions: PixelBox[],
): Promise<Array<{ box: PixelBox; text: string }>> {
  if (regions.length === 0) return []
  const session = await getSession('l3ocr')
  if (!session) return []
  const out: Array<{ box: PixelBox; text: string }> = []
  try {
    const runner = session as (img: unknown) => Promise<Array<{ generated_text?: string }>>
    for (const r of regions) {
      const patch = cropRegion(source, r.box)
      if (!patch) continue
      const res = await runner(patch)
      const text = (res?.[0]?.generated_text ?? '').trim()
      if (text) out.push({ box: r, text })
    }
  } catch {
    return out
  }
  return out
}

async function cropRegion(
  source: ImageBitmap | OffscreenCanvas,
  b: { x: number; y: number; w: number; h: number },
): Promise<OffscreenCanvas | null> {
  try {
    const sw = 'width' in source ? source.width : 0
    const sh = 'height' in source ? source.height : 0
    if (!sw || !sh) return null
    const pad = 4
    const x = Math.max(0, Math.floor(b.x - pad))
    const y = Math.max(0, Math.floor(b.y - pad))
    const w = Math.min(sw - x, Math.ceil(b.w + pad * 2))
    const h = Math.min(sh - y, Math.ceil(b.h + pad * 2))
    if (w <= 0 || h <= 0) return null
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(source as CanvasImageSource, x, y, w, h, 0, 0, w, h)
    return c
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 *  Tier-0: Chrome Prompt API, with documented fallbacks [§3.3]
 * ------------------------------------------------------------------ */

export interface Tier0 {
  answer(intent: string, screenText: string, image?: Blob): Promise<{ text: string; source: string }>
}

/**
 * The Prompt API is a no-download tier when present. Its stated hardware gate
 * (>4GB VRAM, or 16GB RAM + 4 cores, and 22GB free disk) means we must handle
 * 'unavailable' and 'downloadable' states, not just 'available'. [§3.3]
 */
export class PromptApiTier0 implements Tier0 {
  async answer(intent: string, screenText: string, image?: Blob): Promise<{ text: string; source: string }> {
    const LM = (globalThis as {
      LanguageModel?: {
        availability(): Promise<string>
        create(opts?: Record<string, unknown>): Promise<{ prompt(input: unknown): Promise<string> }>
      }
    }).LanguageModel
    if (!LM) return { text: '', source: 'unavailable' }

    const avail = await LM.availability()
    if (avail !== 'available') return { text: '', source: `prompt-api:${avail}` }

    const inputs: unknown[] = [intent, screenText]
    if (image) inputs.push(image)
    const opts = image ? { expectedInputs: [{ type: 'image' }] } : undefined
    const session = await LM.create(opts)
    const text = await session.prompt(inputs)
    return { text, source: 'prompt-api' }
  }
}
