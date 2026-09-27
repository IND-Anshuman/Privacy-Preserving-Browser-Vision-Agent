/**
 * Model sessions — transformers.js v4 / ONNX Runtime Web. ARCHITECTURE.md §3.
 *
 * Two rules drive this whole file:
 *
 *  1. SESSIONS ARE CACHED FOREVER. Session construction dominates cold latency
 *     (§7); a model is loaded once per extension lifetime and reused. Weights
 *     land in Cache Storage via the transformers.js Hub cache, so the "downloaded
 *     once, ever" budget is real rather than aspirational.
 *
 *  2. NOTHING BLOCKS THE PIPELINE. If a model is missing, still loading, or
 *     fails, we return a typed "unavailable" result and the cascade degrades a
 *     layer. We never block a run on a download, and we never fail closed to
 *     "no redaction" — we fail closed to "L0/L1 only, still private".
 */
import { CASCADE_BY_PRESSURE, type PressureState } from '@/lib/messages'
import type { PiiClass } from '@/lib/schema'

export const MODEL_IDS = {
  l2: 'onnx-community/gliner_multi_pii-v1',
  l3face: 'onnx-community/BlazeFace',
  l3text: 'onnx-community/dbnetpp-mobilev2',
  audit: 'HuggingFaceTB/SmolVLM-256M-Instruct',
} as const

export type ModelId = keyof typeof MODEL_IDS

export interface ModelCard {
  id: ModelId
  repo: string
  task: 'ner' | 'detection' | 'vlm'
  approxBytes: number
  license: string
  device: 'webgpu' | 'wasm'
}

export const MODEL_CARDS: ModelCard[] = [
  { id: 'l2', repo: MODEL_IDS.l2, task: 'ner', approxBytes: 340 * 1024 * 1024, license: 'Apache-2.0', device: 'webgpu' },
  { id: 'l3face', repo: MODEL_IDS.l3face, task: 'detection', approxBytes: 0.2 * 1024 * 1024, license: 'Apache-2.0', device: 'webgpu' },
  { id: 'l3text', repo: MODEL_IDS.l3text, task: 'detection', approxBytes: 4.6 * 1024 * 1024, license: 'Apache-2.0', device: 'wasm' },
  { id: 'audit', repo: MODEL_IDS.audit, task: 'vlm', approxBytes: 256 * 1024 * 1024, license: 'Apache-2.0', device: 'webgpu' },
]

/* ------------------------------------------------------------------ *
 *  Session cache
 * ------------------------------------------------------------------ */

type Session = unknown

const sessions = new Map<string, Promise<Session>>()
const loadTimings = new Map<string, number>()
let device: 'webgpu' | 'wasm' = 'wasm'
let deviceNote = 'not yet probed'

/** Probe WebGPU once. Falls back to WASM, which is mandatory, not a nicety. */
export async function initDevice(): Promise<'webgpu' | 'wasm'> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) {
    device = 'wasm'
    deviceNote = 'no navigator.gpu — WASM SIMD+threads path'
    return device
  }
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) {
      device = 'wasm'
      deviceNote = 'no WebGPU adapter — WASM path'
      return device
    }
    device = 'webgpu'
    deviceNote = 'WebGPU adapter acquired'
  } catch {
    device = 'wasm'
    deviceNote = 'WebGPU probe threw — WASM path'
  }
  return device
}

export function getDeviceInfo(): { device: 'webgpu' | 'wasm'; note: string } {
  return { device, note: deviceNote }
}

/**
 * Load a model session, memoized. Returns a promise so concurrent callers
 * share one download rather than racing.
 */
export async function getSession(id: ModelId): Promise<Session | null> {
  const key = `${id}@${device}`
  const existing = sessions.get(key)
  if (existing) return existing.catch(() => null)

  const t0 = performance.now()
  const p = (async (): Promise<Session | null> => {
    try {
      // Lazy import: the transformer runtime is ~1MB of JS we only pay for on
      // the first inference, and the WASM bundle must not load on WebGPU.
      const mod = (await import('@huggingface/transformers')) as {
        pipeline: (task: string, repo: string, opts?: Record<string, unknown>) => Promise<Session>
        env: { allowLocalModels: boolean; backends: Record<string, unknown> }
      }
      mod.env.allowLocalModels = false
      const task = MODEL_CARDS.find((m) => m.id === id)!.task
      const s = await mod.pipeline(task as never, MODEL_IDS[id], {
        device: device === 'webgpu' ? 'webgpu' : 'wasm',
        dtype: 'q8',
      })
      loadTimings.set(id, performance.now() - t0)
      return s
    } catch {
      return null
    }
  })()

  sessions.set(key, p as Promise<Session>)
  return p.catch(() => null)
}

export function getLoadTimings(): Record<string, number> {
  return Object.fromEntries(loadTimings)
}

/* ------------------------------------------------------------------ *
 *  L2 — zero-shot NER over DOM text
 * ------------------------------------------------------------------ */

export interface NerSpan {
  text: string
  label: string
  score: number
  start: number
  end: number
}

const L2_LABELS = [
  'person',
  'email',
  'phone',
  'address',
  'credit card',
  'passport number',
  'driver licence',
  'date of birth',
  'national id',
] as const

/** GLiNER label → our taxonomy. Unmapped labels are dropped, not guessed. */
const LABEL_MAP: Record<string, PiiClass> = {
  person: 'PERSON',
  email: 'EMAIL',
  phone: 'PHONE',
  address: 'ADDRESS',
  'credit card': 'CREDIT_CARD',
  'passport number': 'PASSPORT',
  'driver licence': 'DL',
  'date of birth': 'DOB',
  'national id': 'AADHAAR',
}

export function mapL2Label(label: string): PiiClass | null {
  return LABEL_MAP[label.toLowerCase().trim()] ?? null
}

export async function runL2(texts: string[]): Promise<{ spans: NerSpan[]; ms: number; available: boolean }> {
  const t0 = performance.now()
  const session = await getSession('l2')
  if (!session) return { spans: [], ms: performance.now() - t0, available: false }

  try {
    const runner = session as (input: string[], opts: Record<string, unknown>) => Promise<Array<Array<NerSpan>>>
    const out = await runner(texts, { labels: L2_LABELS as unknown as string[] })
    const spans: NerSpan[] = []
    out.forEach((rows) => {
      for (const r of rows) {
        if (mapL2Label(r.label)) spans.push(r)
      }
    })
    return { spans, ms: performance.now() - t0, available: true }
  } catch {
    return { spans: [], ms: performance.now() - t0, available: false }
  }
}

/* ------------------------------------------------------------------ *
 *  L3 — pixels: face + text detection
 * ------------------------------------------------------------------ */

export interface PixelBox {
  box: { x: number; y: number; w: number; h: number }
  score: number
  cls: PiiClass
}

export async function runL3Faces(source: ImageBitmap | OffscreenCanvas): Promise<{ boxes: PixelBox[]; ms: number; available: boolean }> {
  const t0 = performance.now()
  const session = await getSession('l3face')
  if (!session) return { boxes: [], ms: performance.now() - t0, available: false }
  try {
    const runner = session as (img: unknown) => Promise<Array<{ box?: { x1: number; y1: number; x2: number; y2: number }; score?: number }>>
    const dets = await runner(source)
    return {
      boxes: dets.map((d) => ({
        box: {
          x: d.box?.x1 ?? 0,
          y: d.box?.y1 ?? 0,
          w: (d.box?.x2 ?? 0) - (d.box?.x1 ?? 0),
          h: (d.box?.y2 ?? 0) - (d.box?.y1 ?? 0),
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

export async function runL3Text(source: ImageBitmap | OffscreenCanvas): Promise<{ boxes: PixelBox[]; ms: number; available: boolean }> {
  const t0 = performance.now()
  const session = await getSession('l3text')
  if (!session) return { boxes: [], ms: performance.now() - t0, available: false }
  try {
    const runner = session as (img: unknown) => Promise<Array<{ box?: [number, number, number, number]; score?: number }>>
    const dets = await runner(source)
    return {
      boxes: dets.map((d) => {
        const b = d.box ?? [0, 0, 0, 0]
        return {
          box: { x: b[0] ?? 0, y: b[1] ?? 0, w: (b[2] ?? 0) - (b[0] ?? 0), h: (b[3] ?? 0) - (b[1] ?? 0) },
          score: d.score ?? 0.8,
          cls: 'API_KEY' as PiiClass, // refined by re-running L1/L2 on the OCR'd text
        }
      }),
      ms: performance.now() - t0,
      available: true,
    }
  } catch {
    return { boxes: [], ms: performance.now() - t0, available: false }
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
