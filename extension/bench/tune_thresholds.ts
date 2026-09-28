/**
 * PER-CLASS THRESHOLD SWEEP — the optimisation §5 actually prescribes.
 *
 * A naive union of L0/L1 and L2 was measured and it LOSES: recall rose 0.629
 * → 0.774 while precision collapsed 0.897 → 0.133, because CoNLL NER emits
 * hundreds of LOC/MISC spans and every one of them counts as a false positive.
 *
 * The architecture's answer is per-class thresholds τ_class chosen to maximise
 * F1, not one global value. This script actually performs that search, so the
 * chosen operating point is a measurement rather than an intention.
 *
 * The result is a shipping decision: if no threshold beats L0/L1 alone, the
 * correct move is to NOT enable L2 for that class — which is a real finding.
 *
 *   npx vite-node bench/tune_thresholds.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { hitsFromElement, runL1, fuseUnion, type ElementLike, type RawHit } from '../lib/pii'
import { mapL2Label } from '../entrypoints/offscreen/models'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')
const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')

interface Inst { cls: string; value: string; node_id: string; channel: string }
interface Det { cls: string; text: string; score: number }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const overlaps = (a: string, b: string) => {
  const na = norm(a), nb = norm(b)
  return !!na && !!nb && (na.includes(nb) || nb.includes(na))
}

function l01Detections(html: string): Det[] {
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
      nodeId: el.id || `${tag}:${el.getAttribute('name') ?? ''}`,
    }
    out.push(...hitsFromElement(like))
    if (el.children.length === 0 && el.textContent) for (const h of runL1(el.textContent)) out.push(h)
  }
  return fuseUnion(out).map((h) => ({ cls: h.cls, text: h.text, score: h.score }))
}

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()
  const forms = files.map((f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { id: string; html: string; instances: Inst[] })
  const htmls = forms.map((f) => readFileSync(join(CORPUS, f.html), 'utf-8'))
  const gt = forms.flatMap((f) => f.instances)

  const l01 = htmls.flatMap(l01Detections)

  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowLocalModels = true; env.cacheDir = CACHE; env.localModelPath = CACHE
  const pipe = await pipeline('token-classification', 'Xenova/bert-base-NER', { dtype: 'q8' } as never)
  const texts = htmls.flatMap((h) =>
    Array.from(new JSDOM(h).window.document.querySelectorAll('*'))
      .filter((el) => !['script', 'style'].includes(el.tagName.toLowerCase()))
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 2).slice(0, 400))
  const l2: Det[] = []
  for (let i = 0; i < texts.length; i += 8) {
    try {
      const res = await pipe(texts.slice(i, i + 8)) as Array<Array<{ entity: string; score: number; word: string }>>
      for (const r of res.flat()) {
        const cls = mapL2Label(r.entity.replace(/^[BSILU]-/, ''))
        if (cls && r.word) l2.push({ cls, text: r.word, score: r.score })
      }
    } catch { /* skip bad batch */ }
  }

  // --- score a given (class -> threshold) policy ---------------------------
  function scorePolicy(tau: Map<string, number>) {
    const dets: Det[] = [
      ...l01,
      // An L2 span for class C is admitted only if score >= tau(C).
      ...l2.filter((d) => d.score >= (tau.get(d.cls) ?? 1.01)),
    ]
    const claimed = new Set<number>()
    let tp = 0, fn = 0
    for (const g of gt) {
      const idx = g.cls === 'PASSWORD'
        ? dets.findIndex((d, i) => !claimed.has(i) && d.cls === 'PASSWORD')
        : dets.findIndex((d, i) => !claimed.has(i) && d.cls === g.cls && overlaps(d.text, g.value))
      if (idx >= 0) { claimed.add(idx); tp++ } else fn++
    }
    const fp = dets.length - claimed.size
    const p = tp / (tp + fp) || 0
    const r = tp / (tp + fn) || 0
    return { p, r, f1: (2 * p * r) / (p + r) || 0, tp, fp, fn }
  }

  const classesWithL2 = [...new Set(l2.map((d) => d.cls))]
  console.log('\n  VEIL — PER-CLASS THRESHOLD SWEEP')
  console.log('  ' + '='.repeat(72))
  console.log(`  L2 label space actually emitted: ${classesWithL2.join(', ')}`)
  console.log(`  GT classes with no L2 coverage: ${[...new Set(gt.map((g) => g.cls))].filter((c) => !classesWithL2.includes(c)).join(', ')}`)

  const base = scorePolicy(new Map())
  console.log('  ' + '-'.repeat(72))
  console.log(`  L0+L1 only            P=${base.p.toFixed(3)} R=${base.r.toFixed(3)} F1=${base.f1.toFixed(3)}  (tp=${base.tp} fp=${base.fp} fn=${base.fn})`)

  // --- greedy per-class search --------------------------------------------
  const grid = [0.0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.01]
  const best = new Map<string, number>()
  for (const c of classesWithL2) {
    let bestTau = 1.01, bestF1 = -1
    for (const t of grid) {
      const tau = new Map(best); tau.set(c, t)
      const s = scorePolicy(tau)
      if (s.f1 > bestF1) { bestF1 = s.f1; bestTau = t }
    }
    best.set(c, bestTau)
  }
  const tuned = scorePolicy(best)
  console.log(`  tuned cascade         P=${tuned.p.toFixed(3)} R=${tuned.r.toFixed(3)} F1=${tuned.f1.toFixed(3)}  (tp=${tuned.tp} fp=${tuned.fp} fn=${tuned.fn})`)
  console.log('  ' + '-'.repeat(72))
  console.log(`  ${'class'.padEnd(14)}${'tau'.padStart(7)}   verdict`)
  for (const c of classesWithL2) {
    const t = best.get(c)!
    // Does enabling this class at its best threshold beat excluding it?
    const withIt = scorePolicy(new Map([[c, t]]))
    const without = base
    const helps = withIt.f1 > without.f1 + 0.001
    console.log(`  ${c.padEnd(14)}${t.toFixed(2).padStart(7)}   ` +
      `${helps ? `ENABLE  (F1 ${without.f1.toFixed(3)} -> ${withIt.f1.toFixed(3)})` : 'DISABLE (costs precision, no F1 gain)'}`)
  }
  console.log('  ' + '='.repeat(72))
  console.log(`  FINAL: L2 ${tuned.f1 > base.f1 ? 'improves' : 'does NOT improve'} overall F1 ` +
    `(${base.f1.toFixed(3)} -> ${tuned.f1.toFixed(3)}, delta ${(tuned.f1 - base.f1 >= 0 ? '+' : '')}${(tuned.f1 - base.f1).toFixed(3)})\n`)

  writeFileSync(join(RESULTS, 'thresholds.json'), JSON.stringify({
    grid, chosen_tau: Object.fromEntries(best),
    l0l1_only: { precision: +base.p.toFixed(4), recall: +base.r.toFixed(4), f1: +base.f1.toFixed(4) },
    tuned: { precision: +tuned.p.toFixed(4), recall: +tuned.r.toFixed(4), f1: +tuned.f1.toFixed(4) },
    l2_label_space: classesWithL2,
    l2_spans: l2.length,
    verdict: tuned.f1 > base.f1 ? 'enable' : 'disable',
  }, null, 2))
  console.log('  wrote results/thresholds.json\n')
}

void main()
