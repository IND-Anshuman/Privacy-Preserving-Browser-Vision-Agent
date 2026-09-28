/**
 * THRESHOLD TUNING against the real PII model.
 *
 * measure_pii_l2.ts measured raw L2 at P=0.119 R=0.569 F1=0.197: recall is
 * excellent (PERSON 1.00) and precision is not, which is exactly the shape that
 * per-class thresholds exist to fix. This script sweeps τ per class and reports
 * the operating point, then reports what the FUSED L0+L1+L2 cascade scores.
 *
 * Nothing is asserted in advance; the numbers come out of the run.
 *
 *   npx vite-node bench/tune_pii_thresholds.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { pipeline, env } from '@huggingface/transformers'
import { hitsFromElement, runL1, fuseUnion, REDACTED_PASSWORD, type ElementLike, type RawHit } from '../lib/pii'
import { mergeTokens, normaliseRows, recoverOffsets } from '../entrypoints/offscreen/models'
import { mapL2Label } from '../entrypoints/offscreen/ner'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')
const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
env.allowLocalModels = true; env.cacheDir = CACHE; env.localModelPath = CACHE

interface Inst { cls: string; value: string; node_id: string; channel: string }
interface Det { cls: string; text: string; score: number }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const overlaps = (a: string, b: string) => {
  const na = norm(a), nb = norm(b)
  return !!na && !!nb && (na.includes(nb) || nb.includes(na))
}

function l01(html: string): Det[] {
  const doc = new JSDOM(html).window.document
  const out: RawHit[] = []
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    const dataAttrs: Record<string, string> = {}
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value
    const like: ElementLike = {
      tag, type: el.getAttribute('type') ?? undefined, id: el.id || undefined,
      name: el.getAttribute('name') ?? undefined, placeholder: el.getAttribute('placeholder') ?? undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined, title: el.getAttribute('title') ?? undefined,
      alt: el.getAttribute('alt') ?? undefined, autocomplete: el.getAttribute('autocomplete') ?? undefined,
      value: 'value' in el ? (el as HTMLInputElement).value : undefined, dataAttrs,
    }
    out.push(...hitsFromElement(like))
    if (el.children.length === 0 && el.textContent) for (const h of runL1(el.textContent)) out.push(h)
  }
  return fuseUnion(out).map((h) => ({ cls: h.cls, text: h.text, score: h.score }))
}

function score(gt: Inst[], dets: Det[]) {
  const claimed = new Set<Det>()
  let tp = 0, fn = 0
  for (const g of gt) {
    const hit = g.cls === 'PASSWORD'
      ? dets.find((d) => !claimed.has(d) && d.cls === 'PASSWORD')
      : dets.find((d) => !claimed.has(d) && d.cls === g.cls && overlaps(d.text, g.value))
    if (hit) { claimed.add(hit); tp++ } else fn++
  }
  const fp = dets.length - claimed.size
  const p = tp / (tp + fp) || 0
  const r = tp / (tp + fn) || 0
  return { p, r, f1: (2 * p * r) / (p + r) || 0, tp, fp, fn }
}

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()
  const forms = files.map((f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { id: string; html: string; instances: Inst[] })
  const gt = forms.flatMap((f) => f.instances)
  const htmls = forms.map((f) => readFileSync(join(CORPUS, f.html), 'utf-8'))

  const pipe = await pipeline('token-classification', 'onnx-community/bert-small-pii-detection-ONNX', { dtype: 'q8' } as never)
  const l2: Det[] = []
  const t0 = performance.now()
  for (const h of htmls) {
    const doc = new JSDOM(h).window.document
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      if (['script', 'style'].includes(el.tagName.toLowerCase())) continue
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!t || t.length <= 2) continue
      try {
        const raw = await pipe(t.slice(0, 400))
        for (const row of normaliseRows(raw)) {
          for (const s of mergeTokens(recoverOffsets(row, t), t)) {
            const cls = mapL2Label(s.label)
            if (cls) l2.push({ cls, text: s.text, score: s.score })
          }
        }
      } catch { /* skip */ }
    }
  }
  const inferS = (performance.now() - t0) / 1000
  const l01d = htmls.flatMap(l01)

  console.log('\n  VEIL — THRESHOLD TUNING (real PII model + L0/L1)')
  console.log('  ' + '='.repeat(74))
  console.log(`  corpus   : ${gt.length} GT instances`)
  console.log(`  L2 spans : ${l2.length} in ${inferS.toFixed(1)}s`)
  console.log(`  L0+L1    : ${l01d.length} spans`)

  const base = score(gt, l01d)
  console.log('  ' + '-'.repeat(74))
  console.log(`  L0+L1 ONLY        P=${base.p.toFixed(3)} R=${base.r.toFixed(3)} F1=${base.f1.toFixed(3)}  (tp=${base.tp} fp=${base.fp} fn=${base.fn})`)

  // --- per-class threshold search -----------------------------------------
  const grid = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 1.01]
  const classes = [...new Set(l2.map((d) => d.cls))].sort()
  const best = new Map<string, number>()

  console.log('  ' + '-'.repeat(74))
  console.log(`  ${'class'.padEnd(12)}${'tau'.padStart(6)}  ${'F1 gain'.padStart(9)}  verdict`)
  for (const c of classes) {
    let bT = 1.01, bF = -Infinity
    for (const t of grid) {
      const s = score(gt, [...l01d, ...l2.filter((d) => d.cls !== c || d.score >= t)])
      if (s.f1 > bF) { bF = s.f1; bT = t }
    }
    best.set(c, bT)
    const withIt = score(gt, [...l01d, ...l2.filter((d) => d.score >= (best.get(d.cls) ?? 1.01))])
    void withIt
    const only = score(gt, [...l01d, ...l2.filter((d) => d.cls === c && d.score >= bT)])
    const gain = only.f1 - base.f1
    console.log(`  ${c.padEnd(12)}${bT.toFixed(2).padStart(6)}  ${(gain >= 0 ? '+' : '') + gain.toFixed(3)}`.padEnd(40) +
      (gain > 0.0005 ? 'ENABLE' : 'skip (no F1 gain)'))
  }

  const tau = best
  const fused = score(gt, [...l01d, ...l2.filter((d) => d.score >= (tau.get(d.cls) ?? 1.01))])
  console.log('  ' + '-'.repeat(74))
  console.log(`  TUNED CASCADE     P=${fused.p.toFixed(3)} R=${fused.r.toFixed(3)} F1=${fused.f1.toFixed(3)}  (tp=${fused.tp} fp=${fused.fp} fn=${fused.fn})`)
  console.log(`  DELTA vs L0+L1   F1 ${(fused.f1 - base.f1 >= 0 ? '+' : '')}${(fused.f1 - base.f1).toFixed(3)}   ` +
    `R ${(fused.r - base.r >= 0 ? '+' : '')}${(fused.r - base.r).toFixed(3)}   ` +
    `P ${(fused.p - base.p >= 0 ? '+' : '')}${(fused.p - base.p).toFixed(3)}`)

  // per-class recall at the chosen operating point
  console.log('  ' + '-'.repeat(74))
  console.log(`  ${'class'.padEnd(14)}${'gt'.padStart(4)}${'L0+L1'.padStart(8)}${'cascade'.padStart(9)}`)
  const pc = new Map<string, { g: number; b: number; f: number }>()
  for (const g of gt) {
    const e = pc.get(g.cls) ?? { g: 0, b: 0, f: 0 }
    e.g++
    if (l01d.some((d) => d.cls === g.cls && overlaps(d.text, g.value)) || (g.cls === 'PASSWORD' && l01d.some((d) => d.cls === 'PASSWORD'))) e.b++
    if ([...l01d, ...l2.filter((d) => d.score >= (tau.get(d.cls) ?? 1.01))]
      .some((d) => d.cls === g.cls && (g.cls === 'PASSWORD' || overlaps(d.text, g.value)))) e.f++
    pc.set(g.cls, e)
  }
  for (const [c, e] of [...pc].sort((a, b) => b[1].g - a[1].g)) {
    const d = e.f - e.b
    console.log(`  ${c.padEnd(14)}${String(e.g).padStart(4)}${String(e.b).padStart(8)}${String(e.f).padStart(9)}` +
      (d === 0 ? '   (no change)' : `   (${d >= 0 ? '+' : ''}${d})`))
  }
  console.log('  ' + '='.repeat(74))

  writeFileSync(join(RESULTS, 'thresholds.json'), JSON.stringify({
    measured: true, model: 'onnx-community/bert-small-pii-detection-ONNX',
    l2_inference_s: +inferS.toFixed(1), l2_spans: l2.length, l01_spans: l01d.length,
    l0l1_only: { precision: +base.p.toFixed(4), recall: +base.r.toFixed(4), f1: +base.f1.toFixed(4) },
    tuned: { precision: +fused.p.toFixed(4), recall: +fused.r.toFixed(4), f1: +fused.f1.toFixed(4) },
    delta: { f1: +(fused.f1 - base.f1).toFixed(4), recall: +(fused.r - base.r).toFixed(4), precision: +(fused.p - base.p).toFixed(4) },
    tau: Object.fromEntries(tau),
    per_class: Object.fromEntries(pc),
  }, null, 2))
  console.log('  wrote results/thresholds.json\n')
}

void main()
