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
  /** NMS-free detector, 3 MB int8. 14× smaller than DETR. */
  l3face: 'onnx-community/yolov10n',
  /** OCR decoder for canvas/image text. 39 MB q8. */
  l3ocr: 'Xenova/trocr-small-printed',
  /** Local VLM for the optional audit pass. */
  audit: 'HuggingFaceTB/SmolVLM-256M-Instruct',
} as const

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
 * Face detection over the pixel channel.
 *
 * Uses NMS-free YOLOv10n (3 MB int8) rather than DETR (43 MB): DETR needs a
 * hand-rolled NMS postprocess — the slowest part of its inference — and the
 * whole model is 14× larger for a job where recall matters far more than box
 * precision, because we over-redact faces by design (§5).
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
        .filter((d) => d.label === 'person' || d.box === undefined)
        .map((d) => ({
          box: {
            x: d.box?.xmin ?? 0, y: d.box?.ymin ?? 0,
            w: (d.box?.xmax ?? 0) - (d.box?.xmin ?? 0),
            h: (d.box?.ymax ?? 0) - (d.box?.ymin ?? 0),
          },
          score: d.score ?? 0.9,
          cls: 'FACE' as PiiClass,
        })),
      ms: performance.now() - t0,
      available: true,
    }
  } catch {
    return { boxes: [], ms: performance.now() - t0, available: false }
  }
}

/**
 * Text-in-image regions — a REGION MARKER, not a detector.
 *
 * It says "there is text here" and nothing more. The class is deliberately
 * neutral, because labelling every text region with a specific PII class is
 * exactly the kind of confident nonsense that makes a privacy tool untrustworthy.
 * Callers OCR the region (ocrRegions) and re-run L1/L2 on the recovered string.
 */
export async function runL3Text(
  source: ImageBitmap | OffscreenCanvas,
): Promise<{ boxes: PixelBox[]; ms: number; available: boolean }> {
  const t0 = performance.now()
  const session = await getSession('l3face')
  if (!session) return { boxes: [], ms: performance.now() - t0, available: false }
  try {
    const runner = session as (img: unknown) => Promise<DetOut[]>
    const dets = await runner(source)
    return {
      boxes: dets.map((d) => ({
        box: {
          x: d.box?.xmin ?? 0, y: d.box?.ymin ?? 0,
          w: (d.box?.xmax ?? 0) - (d.box?.xmin ?? 0),
          h: (d.box?.ymax ?? 0) - (d.box?.ymin ?? 0),
        },
        score: d.score ?? 0.8,
        cls: 'DATE' as PiiClass, // neutral marker — see the note above
      })),
      ms: performance.now() - t0,
      available: true,
    }
  } catch {
    return { boxes: [], ms: performance.now() - t0, available: false }
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
