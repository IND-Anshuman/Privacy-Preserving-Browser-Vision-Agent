/**
 * L2 ground-truth measurement — runs a REAL NER model over the REAL corpus.
 *
 * This is the measurement that was missing. L2 had been a structural
 * prediction; now it either produces numbers or it does not.
 *
 * IMPORTANT, AND THE REASON THIS FILE IS FLEXIBLE: the architecture's
 * preferred zero-shot detector (GLiNER, `model_type: gliner`) is NOT
 * loadable by transformers.js — the library rejects the model type outright.
 * That is not a benchmark limitation to work around quietly; it is a finding,
 * and it is why the architecture also specifies a DeBERTa/BERT-class
 * token-classification fallback. This script measures whichever models load,
 * and records which ones did not.
 *
 *   npx vite-node bench/measure_l2.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { pipeline, env } from '@huggingface/transformers'
import { mapL2Label } from '../entrypoints/offscreen/models'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')
const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')

env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE

/** Candidates in preference order. Each declares its pipeline task. */
const CANDIDATES: Array<{ repo: string; task: string; kind: 'zero-shot' | 'ner' }> = [
  { repo: 'onnx-community/gliner_multi_pii-v1', task: 'zero-shot-classification', kind: 'zero-shot' },
  { repo: 'Xenova/bert-base-NER', task: 'token-classification', kind: 'ner' },
]

const ZERO_SHOT_LABELS = ['person', 'email', 'phone', 'address', 'credit card', 'passport number', 'date of birth']

interface Inst {
  cls: string
  value: string
  node_id: string
  channel: string
  span: [number, number] | null
}

function pageTexts(html: string): Array<{ node: string; text: string }> {
  const doc = new JSDOM(html).window.document
  const out: Array<{ node: string; text: string }> = []
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    const node = el.id || `${tag}:${el.getAttribute('name') ?? ''}`
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (t && t.length > 2) out.push({ node, text: t.slice(0, 400) })
  }
  return out
}

interface Det {
  node: string
  cls: string
  score: number
  text: string
}

async function runCandidate(c: (typeof CANDIDATES)[number], texts: string[]): Promise<Det[]> {
  const t0 = performance.now()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipe: any = await pipeline(c.task as never, c.repo, { dtype: 'q8' } as never)
  const loadMs = performance.now() - t0
  console.log(`    loaded in ${(loadMs / 1000).toFixed(1)}s`)

  const out: Det[] = []
  const t1 = performance.now()
  const BATCH = 8
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    try {
      const res = c.kind === 'zero-shot'
        ? await pipe(slice, { labels: ZERO_SHOT_LABELS, multi_label: false })
        : await pipe(slice)
      if (c.kind === 'zero-shot') {
        const rows = res as Array<Array<{ entity: string; score: number }>>
        slice.forEach((s, j) => {
          for (const r of rows[j] ?? []) {
            const cls = mapL2Label(r.entity)
            if (cls) out.push({ node: nodes[i + j]!, cls, score: r.score, text: s.slice(0, 100) })
          }
        })
      } else {
        // token-classification returns per-sequence entity arrays
        const rows = res as Array<Array<{ entity: string; score: number; word: string; index: number }>>
        slice.forEach((s, j) => {
          for (const r of rows[j] ?? []) {
            // BERT-NER emits BIO tags; the leading B- is noise for our purposes.
            const label = r.entity.replace(/^[BSILU]-/, '')
            const cls = mapL2Label(label)
            if (cls) out.push({ node: nodes[i + j]!, cls, score: r.score, text: r.word ?? s.slice(0, 100) })
          }
        })
      }
    } catch {
      // a bad batch must not abort the measurement
    }
  }
  const secs = (performance.now() - t1) / 1000
  console.log(
    `    inferred ${texts.length} texts in ${secs.toFixed(1)}s ` +
      `(${(texts.length / (secs || 1)).toFixed(1)} per sec)`,
  )
  return out
}

// Node id per text, kept parallel so detections can be attributed.
let nodes: string[] = []

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()
  const forms = files.map((f) => {
    const meta = JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as {
      id: string
      html: string
      instances: Inst[]
    }
    // `id` is syn_00, `f` is form_00.json, and `meta.html` is the page file.
    return { ...meta, file: f }
  })

  // Build the full text list once.
  // The metadata `id` is `syn_00` but the file on disk is `form_00.json`, so
  // the filename comes from the glob, never from the id.
  const texts: string[] = []
  nodes = []
  for (const form of forms) {
    for (const t of pageTexts(readFileSync(join(CORPUS, form.file), 'utf-8'))) {
      texts.push(t.text)
      nodes.push(t.node)
    }
  }

  console.log('\n  VEIL — L2 MEASUREMENT (real NER weights, real corpus)')
  console.log('  ' + '='.repeat(74))
  console.log(`  cache    : ${CACHE}`)
  console.log(`  corpus   : ${forms.length} forms, ${texts.length} text nodes`)

  const results: Record<string, unknown>[] = []
  const failed: Array<{ repo: string; reason: string }> = []
  let chosen: Det[] = []

  for (const c of CANDIDATES) {
    console.log(`\n  trying ${c.repo}  (${c.task})`)
    try {
      chosen = await runCandidate(c, texts)
      results.push({ repo: c.repo, task: c.task, loaded: true })
      break
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)
      console.log(`    FAILED: ${reason}`)
      failed.push({ repo: c.repo, reason })
      results.push({ repo: c.repo, task: c.task, loaded: false, reason })
    }
  }

  if (!chosen.length) {
    console.log('\n  ' + '-'.repeat(74))
    console.log('  NO L2 MODEL COULD BE LOADED.')
    console.log('  L2 is reported as UNVERIFIED — explicitly not as a zero. A model that')
    console.log('  will not load is a gap in the system, not a detector that finds nothing.\n')
    writeFileSync(join(RESULTS, 'l2.json'), JSON.stringify({
      measured: false, candidates: results, failed,
      note: 'No L2 model loaded; L2 accuracy is UNKNOWN, not zero.',
    }, null, 2))
    process.exitCode = 1
    return
  }

  // --- score ---------------------------------------------------------------
  // Attribution matters here. The NER emits SPANS (a word, possibly
  // subword-split) while the ground truth is a VALUE on a node. Matching a
  // detection to ground truth by node alone credits the whole node, and
  // matching by exact word equality misses BERT's "An ##t" subword splits.
  // A detection therefore counts as a true positive when its recovered text
  // overlaps the ground-truth VALUE, which is the only comparison that means
  // "this detector found this piece of PII".
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const overlaps = (a: string, b: string) => {
    const na = norm(a), nb = norm(b)
    if (!na || !nb) return false
    return na.includes(nb) || nb.includes(na)
  }

  let tp = 0, fp = 0, fn = 0
  const perClass = new Map<string, { tp: number; fp: number; fn: number }>()
  const bump = (c: string, k: 'tp' | 'fp' | 'fn') => {
    const e = perClass.get(c) ?? { tp: 0, fp: 0, fn: 0 }
    e[k]++
    perClass.set(c, e)
  }
  const claimed = new Set<Det>()

  for (const form of forms) {
    for (const inst of form.instances) {
      // A hit needs the right class AND a text overlap, and must not have
      // been already consumed by an earlier ground-truth instance.
      const hit = chosen.find(
        (d) => !claimed.has(d) && d.cls === inst.cls && overlaps(d.text, inst.value),
      )
      if (hit) { claimed.add(hit); tp++; bump(inst.cls, 'tp') } else { fn++; bump(inst.cls, 'fn') }
    }
  }
  for (const d of chosen) {
    if (!claimed.has(d)) { fp++; bump(d.cls, 'fp') }
  }

  const p = tp / (tp + fp) || 0
  const r = tp / (tp + fn) || 0
  const f1 = (2 * p * r) / (p + r) || 0

  console.log('\n  ' + '-'.repeat(74))
  console.log(`  L2 micro   : P=${p.toFixed(3)} R=${r.toFixed(3)} F1=${f1.toFixed(3)}   (tp=${tp} fp=${fp} fn=${fn})`)
  console.log(`  detections : ${chosen.length} spans over ${texts.length} text nodes`)
  console.log('  per class:')
  for (const [c, v] of [...perClass].sort((a, b) => b[1].tp - a[1].tp)) {
    const pp = v.tp / (v.tp + v.fp) || 0
    const rr = v.tp / (v.tp + v.fn) || 0
    const ff = (2 * pp * rr) / (pp + rr) || 0
    console.log(`    ${c.padEnd(14)} P=${pp.toFixed(2)} R=${rr.toFixed(2)} F1=${ff.toFixed(2)}  tp=${v.tp} fp=${v.fp} fn=${v.fn}`)
  }
  if (chosen.length) {
    console.log('  sample detections:')
    for (const d of chosen.slice(0, 6)) {
      console.log(`    ${d.cls.padEnd(12)} (${d.score.toFixed(2)}) ${d.text.slice(0, 60)}`)
    }
  }
  console.log('  ' + '-'.repeat(74))
  console.log('  NOT MEASURED: WebGPU-vs-WASM split (CPU only here), L3 pixel models,')
  console.log('  heap, and the fused cascade delta.\n')

  writeFileSync(join(RESULTS, 'l2.json'), JSON.stringify({
    measured: true,
    device: 'cpu',
    candidates: results,
    failed,
    micro: { precision: +p.toFixed(4), recall: +r.toFixed(4), f1: +f1.toFixed(4), tp, fp, fn },
    per_class: Object.fromEntries(perClass),
    detections: chosen.length,
    texts_scored: texts.length,
  }, null, 2))
}

void main()
