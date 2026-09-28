/**
 * Client CPU cost measurement — ARCHITECTURE.md §7, §10 (M4/M5).
 *
 * WHY THIS FILE EXISTS
 * The brief says every latency/resource number in the README must come from a
 * measurement script in the repo. This is that script for the CPU-side budget.
 *
 * WHAT IT MEASURES (real work, no mocks)
 *   1. L0+L1 classification over every element of every corpus form
 *   2. The frame-diff gate: 64x64 luma downscale -> dHash -> decision
 *   3. The combined per-cycle client compute cost
 *
 * WHAT IT DOES NOT MEASURE (and must not be claimed from it)
 *   - WebGPU / ONNX inference time (needs real weights + real GPU)
 *   - captureVisibleTab / tabCapture acquisition cost (permission-gated)
 *   - network, server TTFT, or end-to-end p50/p95
 *   - heap, since Node's heap is not the browser's heap
 *
 * READ THE OUTPUT CAREFULLY
 *   This runs on a fast x86 desktop under V8 — the same engine Chrome uses, so
 *   the JS costs are representative. The MACHINE is not representative of a
 *   low-end device. Apply the scaling factor in SCALE below.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { hitsFromElement, runL1, fuseUnion, type ElementLike } from '../lib/pii'
import { toLumaThumbnail, dhash, evaluateGate, commitGate, newGateState } from '../lib/framediff'
import { Pseudonymizer } from '../lib/pseudonym'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')
mkdirSync(RESULTS, { recursive: true })
const WARMUP = 3
const ITER = 25

/* ------------------------------------------------------------------ *
 *  Device scaling
 * ------------------------------------------------------------------ */

interface DeviceClass {
  name: string
  factor: number
  note: string
}

/**
 * Multiplier on this machine's speed. Derived from published single-thread
 * scores, NOT measured by us — treat as an estimate with ~±30% error and
 * re-measure on real hardware before quoting any number to a judge.
 */
const SCALE: Record<string, DeviceClass> = {
  'this-machine': { name: 'this machine (fast x86, V8)', factor: 1, note: 'baseline' },
  'modern-laptop': { name: 'modern laptop (2022+)', factor: 1.8, note: 'low-power laptop / U-series' },
  'old-laptop': { name: 'budget 2015-2018 laptop', factor: 4.5, note: 'the 800MB-GPU class' },
  'integrated': { name: 'desktop with integrated GPU only', factor: 2.5, note: 'no dedicated VRAM' },
  'chromebook': { name: 'low-end Chromebook', factor: 3.5, note: 'Celeron-class' },
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, i)]!
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b)
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1)
  return { mean, p50: pct(s, 50), p95: pct(s, 95), min: s[0] ?? 0, max: s[s.length - 1] ?? 0 }
}

function row(label: string, st: ReturnType<typeof stats>, factor: number): string {
  return (
    `  ${label.padEnd(34)}` +
    `mean ${(st.mean * factor).toFixed(2).padStart(8)} ms` +
    `  p50 ${(st.p50 * factor).toFixed(2).padStart(8)}` +
    `  p95 ${(st.p95 * factor).toFixed(2).padStart(8)}`
  )
}

/* ------------------------------------------------------------------ *
 *  Load corpus
 * ------------------------------------------------------------------ */

const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()
const forms = files.map((f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { html: string; instances: unknown[] })
const htmls = forms.map((f) => readFileSync(join(CORPUS, f.html), 'utf-8'))

/* ------------------------------------------------------------------ *
 *  Workload 1: L0 + L1 over a real page
 * ------------------------------------------------------------------ */

function classifyPage(html: string): { elements: number; hits: number } {
  const doc = new JSDOM(html).window.document
  let elements = 0
  let hits = 0
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    elements++
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
    const found = hitsFromElement(like)
    if (el.children.length === 0 && el.textContent) for (const h of runL1(el.textContent)) found.push({ ...h, nodeId })
    hits += fuseUnion(found).length
  }
  return { elements, hits }
}

/* ------------------------------------------------------------------ *
 *  Workload 2: frame-diff gate on a realistic 1920x1080 frame
 * ------------------------------------------------------------------ */

function makeFrame(w: number, h: number, seed: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      // Structured content with text-like rows, so dHash is not degenerate.
      const band = Math.floor(y / 24) % 2 === 0 ? 210 : 40
      d[i] = (x * 7 + seed) % 256
      d[i + 1] = band
      d[i + 2] = (y * 3 + seed * 2) % 256
      d[i + 3] = 255
    }
  }
  return d
}

function gateCycle(frame: Uint8ClampedArray, state: ReturnType<typeof newGateState>, w: number, h: number): number {
  const luma = toLumaThumbnail(frame, w, h)
  const d = evaluateGate(state, luma, 'domhash')
  commitGate(state, luma, 'domhash')
  return d.tiles.length
}

/* ------------------------------------------------------------------ *
 *  Workload 3: pseudonymization (per-session token minting)
 * ------------------------------------------------------------------ */

function pseudonymCycle(): number {
  const p = new Pseudonymizer('session-bench')
  const values = ['Ankit Sharma', 'ankit@acme.in', '9876543210', 'Ankit Sharma', '₹42,000']
  for (const v of values) p.tokenFor(v, v.includes('@') ? 'EMAIL' : v.includes('₹') ? 'MONEY' : 'PERSON')
  return p.issued().length
}

/* ------------------------------------------------------------------ *
 *  Run
 * ------------------------------------------------------------------ */

function bench(label: string, fn: () => unknown): number[] {
  for (let i = 0; i < WARMUP; i++) fn()
  const out: number[] = []
  for (let i = 0; i < ITER; i++) {
    const t = performance.now()
    fn()
    out.push(performance.now() - t)
  }
  void label
  return out
}

const nodeinfo = process.version
let totalElements = 0
for (const h of htmls) totalElements += classifyPage(h).elements

const l01 = bench('l01', () => { for (const h of htmls) classifyPage(h) })
const perPage = l01.map((t) => t / htmls.length)
const gate = bench('gate', () => {
  const st = newGateState()
  const f = makeFrame(1920, 1080, 1)
  gateCycle(f, st, 1920, 1080)
  gateCycle(f, st, 1920, 1080) // second cycle hits the unchanged path
})
const pseudo = bench('pseudo', () => pseudonymCycle())

console.log('')
console.log('  VEIL — CLIENT CPU MEASUREMENT (real corpus, no mocks)')
console.log('  ' + '='.repeat(78))
console.log(`  node ${nodeinfo} · ${forms.length} forms · ${totalElements} elements total (${Math.round(totalElements / forms.length)}/form)`)
console.log(`  warmup ${WARMUP} · iterations ${ITER}`)
console.log('')
console.log('  MEASURED ON THIS MACHINE (Node/V8 — same engine as Chrome)')
console.log('  ' + '-'.repeat(78))
console.log(row('L0+L1, whole corpus (20 forms)', stats(l01), 1))
console.log(row('L0+L1, per form', stats(perPage), 1))
console.log(row('frame-diff gate, 1920x1080 (2 cyc)', stats(gate), 1))
console.log(row('pseudonym mint, 5 values', stats(pseudo), 1))
console.log('')
console.log('  PROJECTED PER CYCLE, BY DEVICE CLASS  (estimate: measured x factor)')
console.log('  ' + '-'.repeat(78))
for (const key of ['this-machine', 'integrated', 'modern-laptop', 'chromebook', 'old-laptop']) {
  const d = SCALE[key]!
  console.log(`  ${d.name}  [x${d.factor}]  — ${d.note}`)
  console.log(row('  L0+L1 per cycle', stats(perPage), d.factor))
  console.log(row('  frame-diff gate', stats(gate), d.factor))
  console.log('')
}
console.log('  ' + '='.repeat(78))
console.log('  NOT MEASURED HERE (do not quote these from this file):')
console.log('    · L2 NER / L3 detector inference  — needs real weights on a real GPU')
console.log('    · WebGPU compositor + encode        — needs a real device')
console.log('    · captureVisibleTab / tabCapture    — permission-gated')
console.log('    · end-to-end p50/p95, heap, bytes   — needs the built extension')
console.log('    · the scaling factors themselves    — estimates, +/-30%')
console.log('')

// Machine-readable output for the README generator.
writeFileSync(
  join(RESULTS, 'client_cpu.json'),
  JSON.stringify(
    {
      node: nodeinfo,
      forms: forms.length,
      elements: totalElements,
      iterations: ITER,
      measured_this_machine: {
        l01_corpus_ms: stats(l01),
        l01_per_form_ms: stats(perPage),
        frame_diff_2cycles_ms: stats(gate),
        pseudonym_ms: stats(pseudo),
      },
      projected: Object.fromEntries(
        Object.entries(SCALE).map(([k, v]) => [
          k,
          { factor: v.factor, l01_per_form_ms: scaleStats(stats(perPage), v.factor), frame_diff_2cycles_ms: scaleStats(stats(gate), v.factor) },
        ]),
      ),
      not_measured: ['L2/L3 inference', 'WebGPU compositor', 'capture APIs', 'end_to_end_p50_p95', 'heap', 'bytes'],
    },
    null,
    2,
  ),
)

function scaleStats(st: ReturnType<typeof stats>, f: number) {
  return { mean: +(st.mean * f).toFixed(3), p50: +(st.p50 * f).toFixed(3), p95: +(st.p95 * f).toFixed(3) }
}
