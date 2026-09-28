/**
 * THE CORRECTION, MEASURED.
 *
 * An earlier revision of this project concluded that no browser-loadable NER
 * has PII classes, based on `Xenova/bert-base-NER` returning no entities for
 * an email address. That was a true observation of a CoNLL-2003 model (whose
 * label space genuinely has no PII) generalised to the whole family. It was
 * wrong.
 *
 * This script runs `onnx-community/bert-small-pii-detection-ONNX` — 24 PII
 * classes, 27.4 MB q8, Apache-2.0, transformers.js-supported — over the real
 * corpus, and reports what it actually finds. Nothing is asserted in advance.
 *
 *   npx vite-node bench/measure_pii_l2.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { pipeline, env } from '@huggingface/transformers'
import { mergeTokens, normaliseRows, recoverOffsets } from '../entrypoints/offscreen/models'
import { mapL2Label } from '../entrypoints/offscreen/ner'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')
const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
const REPO = 'onnx-community/bert-small-pii-detection-ONNX'

env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE

interface Inst { cls: string; value: string; node_id: string; channel: string }
interface RawTok { entity: string; score: number; word: string; start: number | null; end: number | null; index: number }
interface Det { cls: string; text: string; score: number }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const overlaps = (a: string, b: string) => {
  const na = norm(a), nb = norm(b)
  return !!na && !!nb && (na.includes(nb) || nb.includes(na))
}

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()
  const forms = files.map((f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { id: string; html: string; instances: Inst[] })
  const gt = forms.flatMap((f) => f.instances)

  // Text nodes, in document order, with their source string.
  const texts: string[] = []
  for (const f of forms) {
    const doc = new JSDOM(readFileSync(join(CORPUS, f.html), 'utf-8')).window.document
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      if (['script', 'style'].includes(el.tagName.toLowerCase())) continue
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (t && t.length > 2) texts.push(t.slice(0, 400))
    }
  }

  console.log('\n  VEIL — L2 PII DETECTOR (the correction, measured)')
  console.log('  ' + '='.repeat(74))
  console.log(`  model    : ${REPO}`)
  console.log(`  corpus   : ${forms.length} forms, ${gt.length} GT instances, ${texts.length} text nodes`)

  const t0 = performance.now()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipe: any = await pipeline('token-classification', REPO, { dtype: 'q8' } as never)
  const loadMs = performance.now() - t0
  console.log(`  loaded   : ${(loadMs / 1000).toFixed(1)}s`)

  // --- inference -----------------------------------------------------------
  const t1 = performance.now()
  const dets: Det[] = []
  const BATCH = 8
  for (const text of texts) {
    try {
      // One string per call: the documented transformers.js path, and the only
      // one whose return shape is unambiguous in this build. 790 text nodes
      // take ~7s, which is fine for a benchmark and for a demo page.
      const res = await pipe(text)
      for (const toks of normaliseRows(res)) {
        for (const s of mergeTokens(recoverOffsets(toks, text), text)) {
          const cls = mapL2Label(s.label)
          if (cls) dets.push({ cls, text: s.text, score: s.score })
        }
      }
    } catch { /* a bad input must not abort the measurement */ }
  }
  const inferMs = performance.now() - t1

  console.log('  ' + '-'.repeat(74))
  console.log(`  inference: ${texts.length} texts in ${(inferMs / 1000).toFixed(1)}s ` +
    `(${(texts.length / (inferMs / 1000)).toFixed(1)} per sec, ${(inferMs / Math.max(1, texts.length)).toFixed(0)}ms per text)`)
  console.log(`  spans    : ${dets.length} mapped to our taxonomy`)

  // --- score ---------------------------------------------------------------
  const claimed = new Set<Det>()
  let tp = 0, fn = 0
  const perClass = new Map<string, { tp: number; fp: number; fn: number }>()
  const bump = (c: string, k: 'tp' | 'fp' | 'fn') => {
    const e = perClass.get(c) ?? { tp: 0, fp: 0, fn: 0 }
    e[k]++; perClass.set(c, e)
  }
  for (const g of gt) {
    const hit = dets.find((d) => !claimed.has(d) && d.cls === g.cls && overlaps(d.text, g.value))
    if (hit) { claimed.add(hit); tp++; bump(g.cls, 'tp') } else { fn++; bump(g.cls, 'fn') }
  }
  for (const d of dets) if (!claimed.has(d)) { bump(d.cls, 'fp') }
  const fp = dets.length - claimed.size

  const p = tp / (tp + fp) || 0
  const r = tp / (tp + fn) || 0
  const f1 = (2 * p * r) / (p + r) || 0

  console.log('  ' + '-'.repeat(74))
  console.log(`  L2 micro : P=${p.toFixed(3)} R=${r.toFixed(3)} F1=${f1.toFixed(3)}   (tp=${tp} fp=${fp} fn=${fn})`)
  console.log('  per class (only classes the model can emit are non-zero):')
  const emitted = [...new Set(dets.map((d) => d.cls))].sort()
  for (const cls of emitted) {
    const v = perClass.get(cls)!
    const pp = v.tp / (v.tp + v.fp) || 0
    const rr = v.tp / (v.tp + v.fn) || 0
    const ff = (2 * pp * rr) / (pp + rr) || 0
    console.log(`    ${cls.padEnd(14)} P=${pp.toFixed(2)} R=${rr.toFixed(2)} F1=${ff.toFixed(2)}  tp=${v.tp} fp=${v.fp} fn=${v.fn}`)
  }
  const covered = [...new Set(gt.map((g) => g.cls))].filter((c) => emitted.includes(c))
  const uncovered = [...new Set(gt.map((g) => g.cls))].filter((c) => !emitted.includes(c))
  console.log('  ' + '-'.repeat(74))
  console.log(`  classes WITH L2 coverage     : ${covered.join(', ')}`)
  console.log(`  classes needing L1 only     : ${uncovered.join(', ')}`)
  if (dets.length) {
    console.log('  sample detections:')
    for (const d of dets.slice(0, 8)) console.log(`    ${d.cls.padEnd(13)} ${d.score.toFixed(2)}  ${d.text.slice(0, 50)}`)
  }
  console.log('  ' + '='.repeat(74) + '\n')

  writeFileSync(join(RESULTS, 'l2_pii.json'), JSON.stringify({
    measured: true,
    model: REPO,
    dtype: 'q8',
    device: 'cpu',
    load_ms: Math.round(loadMs),
    texts: texts.length,
    inference_ms: Math.round(inferMs),
    ms_per_text: +(inferMs / Math.max(1, texts.length)).toFixed(1),
    spans: dets.length,
    micro: { precision: +p.toFixed(4), recall: +r.toFixed(4), f1: +f1.toFixed(4), tp, fp, fn },
    per_class: Object.fromEntries(perClass),
    covered_classes: covered,
    uncovered_classes: uncovered,
  }, null, 2))
  console.log('  wrote results/l2_pii.json\n')
}

void main()
