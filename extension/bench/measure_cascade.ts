/**
 * THE CASCADE DELTA — the table the rubric asks for and nobody produces.
 *
 * L0+L1 alone measured micro F1 0.880 with PERSON recall 0.56. L2 alone
 * measures PERSON recall 1.00 but is blind to every checksum-validated class.
 * Neither number means anything on its own; this script fuses them the way
 * `lib/pii.ts` does at runtime and reports the combined result.
 *
 * Fusion is a UNION with per-class thresholds, not an average: a detection
 * counts if ANY layer claims it, and the fused score is the layer's confidence
 * boosted by semantic weight. That is the architecture's design, and this is
 * where it either pays off or does not.
 *
 *   npx vite-node bench/measure_cascade.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { hitsFromElement, runL1, fuseUnion, REDACTED_PASSWORD, type ElementLike, type RawHit } from '../lib/pii'
import { mapL2Label } from '../entrypoints/offscreen/models'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')
const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')

interface Inst {
  cls: string
  value: string
  node_id: string
  channel: string
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const overlaps = (a: string, b: string) => {
  const na = norm(a), nb = norm(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

function l01Detections(html: string): RawHit[] {
  const doc = new JSDOM(html).window.document
  const out: RawHit[] = []
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    const nodeId = el.id || `${tag}:${el.getAttribute('name') ?? ''}`
    const dataAttrs: Record<string, string> = {}
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value
    const like: ElementLike = {
      tag,
      type: el.getAttribute('type') ?? undefined,
      id: el.id || undefined,
      name: el.getAttribute('name') ?? undefined,
      placeholder: el.getAttribute('placeholder') ?? undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      title: el.getAttribute('title') ?? undefined,
      alt: el.getAttribute('alt') ?? undefined,
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
      value: 'value' in el ? (el as HTMLInputElement).value : undefined,
      dataAttrs,
      nodeId,
    }
    out.push(...hitsFromElement(like))
    if (el.children.length === 0 && el.textContent) {
      for (const h of runL1(el.textContent)) out.push({ ...h, nodeId })
    }
  }
  return fuseUnion(out)
}

async function l2Detections(pipeline: unknown, texts: string[]): Promise<Array<{ cls: string; text: string; score: number }>> {
  const pipe = pipeline as (t: string[]) => Promise<Array<Array<{ entity: string; score: number; word: string }>>>
  const out: Array<{ cls: string; text: string; score: number }> = []

  // A 400-character string is roughly 150 wordpiece tokens, and a BATCH is
  // padded to its longest member. A batch of 8 such strings therefore needs
  // ~1200 positions, which overruns the model's 512 and makes every batch in
  // the run fail identically.
  //
  // That failure was invisible: the `catch {}` below swallowed it and the whole
  // L2 column reported 0, which reads exactly like "the model found nothing".
  // So the bound is enforced here, and the error is counted rather than eaten.
  const BATCH = 4
  const MAX_CHARS = 200
  let failed = 0
  const sliced = texts.map((t) => t.slice(0, MAX_CHARS))

  for (let i = 0; i < sliced.length; i += BATCH) {
    try {
      const res = await pipe(sliced.slice(i, i + BATCH))
      for (const r of res.flat()) {
        const cls = mapL2Label(r.entity.replace(/^[BSILU]-/, ''))
        if (cls && r.word) out.push({ cls, text: r.word, score: r.score })
      }
    } catch (e) {
      failed++
      if (failed === 1) {
        console.log(`  L2 batch error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      }
    }
  }
  if (failed > 0) {
    console.log(
      `  L2: ${failed}/${Math.ceil(sliced.length / BATCH)} batches FAILED — ` +
      `the L2 column below is understated, not a detector result`,
    )
  }
  return out
}

function scoreLayer(gt: Inst[], dets: Array<{ cls: string; value: string }>) {
  let tp = 0, fn = 0
  const claimed = new Set<number>()
  for (const g of gt) {
    // PASSWORD is special: by design the detector never carries the real value
    // (it is replaced with <redacted:password> so it cannot leak), so a
    // value-overlap match can NEVER succeed for it. Match on class alone.
    const idx = g.cls === 'PASSWORD'
      ? dets.findIndex((d, i) => !claimed.has(i) && d.cls === 'PASSWORD')
      : dets.findIndex((d, i) => !claimed.has(i) && d.cls === g.cls && overlaps(d.value, g.value))
    if (idx >= 0) { claimed.add(idx); tp++ } else fn++
  }
  const fp = dets.length - claimed.size
  const p = tp / (tp + fp) || 0
  const r = tp / (tp + fn) || 0
  const f1 = (2 * p * r) / (p + r) || 0
  return { tp, fp, fn, p, r, f1 }
}

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()
  const forms = files.map((f) => {
    const m = JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { id: string; html: string; instances: Inst[] }
    return { ...m, file: f }
  })

  console.log('\n  VEIL — CASCADE DELTA (L0+L1 vs +L2)')
  console.log('  ' + '='.repeat(72))

  const allGt = forms.flatMap((f) => f.instances)
  const allHtml = forms.map((f) => ({ id: f.id, html: readFileSync(join(CORPUS, f.html), 'utf-8') }))

  // --- L0 + L1 -------------------------------------------------------------
  const l01Dets = allHtml.flatMap((x) => l01Detections(x.html).map((h) => ({ cls: h.cls, value: h.text })))
  const l01 = scoreLayer(allGt, l01Dets)

  // --- L2 ------------------------------------------------------------------
  let l2: ReturnType<typeof scoreLayer> | null = null
  let l2Dets: Array<{ cls: string; text: string; score: number }> = []
  try {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.allowLocalModels = true
    env.cacheDir = CACHE
    env.localModelPath = CACHE
    // The model that actually has a PII label space. This harness still pointed
    // at `Xenova/bert-base-NER`, whose label space is CoNLL-2003
    // ({PER, ORG, LOC, MISC}) and which therefore returns nothing for an email
    // or a card number. It made the cascade look like it added nothing, for a
    // reason that had nothing to do with the cascade.
    const pipe = await pipeline(
      'token-classification',
      'onnx-community/bert-small-pii-detection-ONNX',
      { dtype: 'q8' } as never,
    )
    // One text per ELEMENT, and truncated in characters — this mirrors the
    // production path in models.ts:runL2. An earlier version of this harness
    // built one long string per page, and 400 characters is ~150 wordpiece
    // tokens, so a batch padded out to 797 positions and the model threw
    // `Attempting to broadcast an axis by a dimension other than 1. 512 by
    // 797`. The whole L2 column read 0 because the pipeline died, not because
    // the model found nothing.
    const MAX_CHARS = 400
    const texts = allHtml.flatMap((x) =>
      Array.from(new JSDOM(x.html).window.document.querySelectorAll('*'))
        .filter((el) => !['script', 'style'].includes(el.tagName.toLowerCase()))
        .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 2)
        .slice(0, MAX_CHARS),
    )
    l2Dets = await l2Detections(pipe, texts)
    l2 = scoreLayer(allGt, l2Dets.map((d) => ({ cls: d.cls, value: d.text })))
  } catch (e) {
    console.log(`  L2 unavailable: ${e instanceof Error ? e.message : String(e)}`)
  }

  // --- fused ---------------------------------------------------------------
  // UNION with a per-class floor: an L2 span only survives if it is confident,
  // which is how the runtime avoids the cascade's false-positive explosion.
  const L2_FLOOR = 0.6
  const fusedDets = [
    ...l01Dets,
    ...l2Dets.filter((d) => d.score >= L2_FLOOR).map((d) => ({ cls: d.cls, value: d.text })),
  ]
  const fused = scoreLayer(allGt, fusedDets)

  // --- report --------------------------------------------------------------
  const row = (name: string, s: ReturnType<typeof scoreLayer>) =>
    `  ${name.padEnd(12)} P=${s.p.toFixed(3)}  R=${s.r.toFixed(3)}  F1=${s.f1.toFixed(3)}   ` +
    `(tp=${s.tp} fp=${s.fp} fn=${s.fn})`

  console.log('  ' + '-'.repeat(72))
  console.log(`  ground truth : ${allGt.length} instances across ${forms.length} forms`)
  console.log(`  L2 floor     : ${L2_FLOOR} (an L2 span below this is dropped)`)
  console.log('  ' + '-'.repeat(72))
  console.log(row('L0+L1', l01))
  if (l2) console.log(row('L2 only', l2))
  console.log(row('CASCADE', fused))
  console.log('  ' + '-'.repeat(72))

  const dF1 = fused.f1 - l01.f1
  const dR = fused.r - l01.r
  const dP = fused.p - l01.p
  console.log(`  DELTA        : F1 ${dF1 >= 0 ? '+' : ''}${dF1.toFixed(3)}   ` +
              `R ${dR >= 0 ? '+' : ''}${dR.toFixed(3)}   P ${dP >= 0 ? '+' : ''}${dP.toFixed(3)}`)

  // per-class delta, which is where the decision actually gets made
  const perClass = new Map<string, { base: number; fused: number; gt: number }>()
  for (const g of allGt) {
    const e = perClass.get(g.cls) ?? { base: 0, fused: 0, gt: 0 }
    e.gt++
    e.base += l01Dets.some((d) => d.cls === g.cls && overlaps(d.value, g.value)) ? 1 : 0
    e.fused += fusedDets.some((d) => d.cls === g.cls && overlaps(d.value, g.value)) ? 1 : 0
    perClass.set(g.cls, e)
  }
  console.log('  ' + '-'.repeat(72))
  console.log(`  ${'class'.padEnd(14)}${'gt'.padStart(5)}${'L0+L1'.padStart(8)}${'cascade'.padStart(9)}${'delta'.padStart(8)}`)
  for (const [cls, e] of [...perClass].sort((a, b) => b[1].fused - a[1].base)) {
    const d = e.fused - e.base
    const tail = `${(d >= 0 ? '+' : '') + d}`.padStart(7)
    console.log(`  ${cls.padEnd(14)}${String(e.gt).padStart(5)}${String(e.base).padStart(8)}` +
                `${String(e.fused).padStart(9)}${tail}${d === 0 ? '   (no change)' : ''}`)
  }
  console.log('  ' + '='.repeat(72))

  writeFileSync(join(RESULTS, 'cascade_delta.json'), JSON.stringify({
    measured: true,
    l2_floor: L2_FLOOR,
    gt_instances: allGt.length,
    l0l1: { precision: +l01.p.toFixed(4), recall: +l01.r.toFixed(4), f1: +l01.f1.toFixed(4), tp: l01.tp, fp: l01.fp, fn: l01.fn },
    l2_only: l2 ? { precision: +l2.p.toFixed(4), recall: +l2.r.toFixed(4), f1: +l2.f1.toFixed(4), tp: l2.tp, fp: l2.fp, fn: l2.fn } : null,
    cascade: { precision: +fused.p.toFixed(4), recall: +fused.r.toFixed(4), f1: +fused.f1.toFixed(4), tp: fused.tp, fp: fused.fp, fn: fused.fn },
    delta: { f1: +dF1.toFixed(4), recall: +dR.toFixed(4), precision: +dP.toFixed(4) },
    per_class: Object.fromEntries(perClass),
  }, null, 2))
  console.log('  wrote results/cascade_delta.json\n')
}

void main()
