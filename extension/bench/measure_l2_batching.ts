/**
 * Batched vs per-string L2 — the M5 claim, measured.
 *
 * The per-string loop cost ~4.1 ms per string, so a 200-node page paid ~820 ms
 * of client compute before anything was redacted. That is the single largest
 * term in a cycle and the reason the §8 "under 250 ms per cycle" target was
 * unreachable. This measures the batched path against the same texts.
 *
 * It also measures something more important than speed: that batching does not
 * change the ANSWER. A batch's rows come back flattened and each row's offsets
 * are relative to its own string, so a mis-attribution would produce plausible
 * spans at wrong offsets — which surfaces as a recall number, not an error.
 * So the two paths are compared span-for-span.
 *
 *   npx vite-node bench/measure_l2_batching.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { env, pipeline } from '@huggingface/transformers'
import { recoverOffsets, mergeTokens, normaliseRows, mapL2Label, L2_MAX_CHARS } from '../entrypoints/offscreen/models'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')
const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE

/** The texts a real page produces: one per element, truncated as production does. */
function collectTexts(): string[] {
  const out: string[] = []
  for (const f of readdirSync(CORPUS).filter((x) => x.startsWith('form_') && x.endsWith('.json')).sort()) {
    const meta = JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { html: string }
    const html = readFileSync(join(CORPUS, meta.html), 'utf-8')
    const doc = new JSDOM(html).window.document
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (t.length > 2) out.push(t.slice(0, L2_MAX_CHARS))
    }
  }
  return out
}

type Pipe = (x: string | string[]) => Promise<unknown>

/** The OLD path, kept verbatim so the comparison is honest. */
async function perString(pipe: Pipe, texts: string[]) {
  const spans: string[] = []
  for (const t of texts) {
    const raw = await pipe(t)
    for (const row of normaliseRows(raw)) {
      for (const s of mergeTokens(recoverOffsets(row, t), t)) spans.push(`${s.label}|${s.text}`)
    }
  }
  return spans
}

/** The NEW path, mirroring runL2's batching and its two bounds. */
async function batched(pipe: Pipe, texts: string[], memBound: number) {
  const TOKEN_BUDGET = 512
  // ~2.6 chars per wordpiece token, measured. An earlier version of this used
  // 0.38 here — the ratio inverted — which floored the batch size to 1 and made
  // the benchmark report a 1.02x "speedup" for batching that did nothing.
  const CHARS_PER_TOKEN = 2.6
  const tokensPerString = L2_MAX_CHARS / CHARS_PER_TOKEN
  const fit = Math.max(1, Math.floor(TOKEN_BUDGET / tokensPerString))
  const size = Math.max(1, Math.min(memBound, fit))
  const spans: string[] = []
  for (let i = 0; i < texts.length; i += size) {
    const chunk = texts.slice(i, i + size)
    const raw = chunk.length === 1 ? await pipe(chunk[0]!) : await pipe(chunk)
    const rows = chunk.length === 1 ? normaliseRows(raw) : (raw as never as ReturnType<typeof normaliseRows>)
    rows.forEach((row, ri) => {
      const src = chunk[ri]
      if (!src) return
      for (const s of mergeTokens(recoverOffsets(row, src), src)) spans.push(`${s.label}|${s.text}`)
    })
  }
  return { spans, size }
}

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const texts = collectTexts()
  console.log('\n  L2 BATCHING — speed and answer-equivalence')
  console.log('  ' + '='.repeat(70))
  console.log(`  texts from the corpus: ${texts.length}  (each <= ${L2_MAX_CHARS} chars)`)

  const pipe = (await pipeline(
    'token-classification',
    'onnx-community/bert-small-pii-detection-ONNX',
    { dtype: 'q8' } as never,
  )) as unknown as Pipe

  // Warm, so the first call's graph construction is not in the timing.
  await perString(pipe, texts.slice(0, 2))

  const t0 = performance.now()
  const a = await perString(pipe, texts)
  const perMs = performance.now() - t0

  const t1 = performance.now()
  const b = await batched(pipe, texts, 8)
  const batMs = performance.now() - t1

  const same = a.length === b.spans.length && a.every((v, i) => v === b.spans[i])
  const setA = new Set(a)
  const setB = new Set(b.spans)
  const overlap = [...setA].filter((v) => setB.has(v)).length

  console.log('  ' + '-'.repeat(70))
  console.log(`  per-string : ${perMs.toFixed(0)} ms  (${a.length} spans)`)
  console.log(`  batched    : ${batMs.toFixed(0)} ms  (${b.spans.length} spans, batch ${b.size})`)
  console.log(`  speedup    : ${(perMs / Math.max(0.001, batMs)).toFixed(2)}x`)
  console.log(`  per string : ${(perMs / texts.length).toFixed(2)} ms -> ${(batMs / texts.length).toFixed(2)} ms`)
  console.log('  ' + '-'.repeat(70))
  console.log(`  IDENTICAL span lists : ${same ? 'YES' : 'NO'}`)
  console.log(`  overlap              : ${overlap}/${setA.size} unique in per-string`)
  if (!same) {
    console.log('  A MISMATCH means batching changed the answer. First few differences:')
    const set = new Set(a)
    for (const s of b.spans) if (!set.has(s)) console.log('    batched only: ' + s)
  }
  // And the class distribution, which is what the per-class policy depends on.
  const byClass: Record<string, number> = {}
  for (const s of b.spans) {
    const cls = mapL2Label(s.split('|')[0]!.replace(/^[BSILU]-/, '')) ?? 'UNMAPPED'
    byClass[cls] = (byClass[cls] ?? 0) + 1
  }
  console.log(`  classes    : ${Object.entries(byClass).map(([c, n]) => `${c}=${n}`).join(' ')}`)
  console.log('  ' + '='.repeat(70))

  writeFileSync(join(RESULTS, 'l2_batching.json'), JSON.stringify({
    texts: texts.length,
    max_chars: L2_MAX_CHARS,
    batch_size: b.size,
    per_string_ms: +perMs.toFixed(1),
    batched_ms: +batMs.toFixed(1),
    speedup: +(perMs / Math.max(0.001, batMs)).toFixed(2),
    spans_per_string: a.length,
    spans_batched: b.spans.length,
    identical_span_lists: same,
    unique_overlap: `${overlap}/${setA.size}`,
    classes: byClass,
    note: 'Node, CPU/WASM, no WebGPU in this runtime. Browser numbers will differ; the ratio is the point.',
  }, null, 2))
  console.log('  wrote results/l2_batching.json\n')
}

void main()
