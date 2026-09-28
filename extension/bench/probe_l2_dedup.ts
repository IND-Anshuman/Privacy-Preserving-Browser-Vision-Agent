/**
 * If batching is out, what actually reduces L2 cost?
 *
 * probe_l2_batch_perf.ts settled batching: best case 1.20x, and the token
 * count CHANGES with batch size (638 at B=1, 630 at B=6, 620 at B=12). A
 * detector whose output depends on how the work was chunked is not a detector
 * you can reason about, so batching is rejected despite being faster.
 *
 * The remaining lever is sending FEWER strings, and the only way to do that
 * without losing recall is to prove the filter loses nothing. Two candidates:
 *
 *   1. DEDUPE. A real form repeats labels — "Email:", "Name:", "Phone:" —
 *      dozens of times. Identical inputs to a deterministic model give
 *      identical outputs, so collapsing duplicates is answer-preserving by
 *      construction. Free.
 *
 *   2. SKIP STRINGS L1 ALREADY COVERS COMPLETELY. If every PII-shaped token in
 *      a string is already matched by a regex (email, PAN, Aadhaar, card),
 *      and the string contains no plausible person name, L2 cannot add a
 *      finding — PERSON being the only admitted class. Testable.
 *
 * This measures both, and reports how many spans the filters would have cost.
 * A filter that drops a span is not a free win; it is a recall loss.
 *
 *   npx vite-node bench/probe_l2_dedup.ts
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

function collectTexts(): string[] {
  const out: string[] = []
  for (const f of readdirSync(CORPUS).filter((x) => x.startsWith('form_') && x.endsWith('.json')).sort()) {
    const meta = JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { html: string }
    const doc = new JSDOM(readFileSync(join(CORPUS, meta.html), 'utf-8')).window.document
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (t.length > 2) out.push(t.slice(0, L2_MAX_CHARS))
    }
  }
  return out
}

/** SKIP STRINGS L1 ALREADY COVERS — the shipping rule, not a local copy.
 *  Imported rather than duplicated so this benchmark measures what runs. */
import { l1CoversIt } from '../lib/l2policy'

type Pipe = (x: string) => Promise<unknown>

async function run(pipe: Pipe, texts: string[]): Promise<string[]> {
  const out: string[] = []
  for (const t of texts) {
    const raw = await pipe(t)
    for (const row of normaliseRows(raw)) {
      for (const s of mergeTokens(recoverOffsets(row, t), t)) out.push(`${s.label}|${s.text}`)
    }
  }
  return out
}

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const all = collectTexts()
  const unique = [...new Set(all)]
  const kept = unique.filter((t) => !l1CoversIt(t))

  console.log('\n  L2 INPUT REDUCTION — can we send fewer strings without losing spans?')
  console.log('  ' + '='.repeat(72))
  console.log(`  raw element texts        : ${all.length}`)
  console.log(`  unique                    : ${unique.length}  (${(100 - (unique.length / all.length) * 100).toFixed(1)}% were repeats)`)
  console.log(`  after the L1-covers filter: ${kept.length}  (${all.length - kept.length} fewer, ${(100 * (all.length - kept.length) / all.length).toFixed(1)}%)`)

  const pipe = (await pipeline(
    'token-classification',
    'onnx-community/bert-small-pii-detection-ONNX',
    { dtype: 'q8' } as never,
  )) as unknown as Pipe

  const t0 = performance.now()
  const base = await run(pipe, all)
  const baseMs = performance.now() - t0

  const t1 = performance.now()
  const reduced = await run(pipe, kept)
  const redMs = performance.now() - t1

  const setBase = new Set(base)
  const setRed = new Set(reduced)
  const lost = [...setBase].filter((v) => !setRed.has(v))

  /**
   * Loss only matters for classes the pipeline ADMITS. `admitL2` is PERSON-only
   * (see lib/l2policy.ts — a Naive union measured P=0.090 and naive admission
   * cost ~2444 false positives), so a filtered-out US_DRIVER_LICENSE span was
   * going to be discarded downstream anyway. Counting it as a loss would make
   * a free filter look lossy, and counting nothing would hide a real PERSON
   * loss. So: split the two.
   */
  const admitted = (span: string): boolean => {
    const cls = mapL2Label(span.split('|')[0]!.replace(/^[BSILU]-/, ''))
    return cls === 'PERSON'
  }
  const lostAdmitted = lost.filter(admitted)
  const lostRejected = lost.filter((s) => !admitted(s))

  console.log('  ' + '-'.repeat(72))
  console.log(`  all texts   : ${baseMs.toFixed(0).padStart(5)} ms -> ${base.length} unique spans`)
  console.log(`  reduced     : ${redMs.toFixed(0).padStart(5)} ms -> ${reduced.length} unique spans`)
  console.log(`  saved       : ${(100 * (1 - redMs / baseMs)).toFixed(1)}% wall clock`)
  console.log(`  ADMITTED spans lost (PERSON, the only admitted class): ${lostAdmitted.length}` +
    (lostAdmitted.length === 0 ? '  <- answer-preserving' : '  <- REAL RECALL LOSS'))
  console.log(`  rejected-class spans dropped by the filter: ${lostRejected.length}` +
    `  (admitL2 discards these downstream anyway)`)
  if (lostAdmitted.length) {
    console.log('  these are genuine losses:')
    for (const l of lostAdmitted.slice(0, 10)) console.log('    ' + l)
  }
  const byClass: Record<string, number> = {}
  for (const s of reduced) {
    const c = mapL2Label(s.split('|')[0]!.replace(/^[BSILU]-/, '')) ?? 'UNMAPPED'
    byClass[c] = (byClass[c] ?? 0) + 1
  }
  console.log(`  classes kept: ${Object.entries(byClass).map(([c, n]) => `${c}=${n}`).join(' ')}`)
  console.log('  ' + '='.repeat(72))

  writeFileSync(join(RESULTS, 'l2_input_reduction.json'), JSON.stringify({
    raw_texts: all.length,
    unique_texts: unique.length,
    after_filter: kept.length,
    reduction_pct: +(100 * (all.length - kept.length) / all.length).toFixed(1),
    all_ms: +baseMs.toFixed(0),
    reduced_ms: +redMs.toFixed(0),
    wall_clock_saved_pct: +(100 * (1 - redMs / baseMs)).toFixed(1),
    spans_lost_total: lost.length,
    spans_lost_admitted: lostAdmitted.length,
    spans_lost_rejected_class: lostRejected.length,
    answer_preserving: lostAdmitted.length === 0,
    lost_examples: lostAdmitted.slice(0, 10),
    classes: byClass,
    note: 'Deterministic per-string inference, no batching. Batching was rejected: 1.20x best case and a batch-size-dependent token count.',
  }, null, 2))
  console.log('  wrote results/l2_input_reduction.json\n')
}

void main()
