/**
 * Why is batching SLOWER and why do the span lists differ?
 *
 * Two separate questions, answered separately because they have different
 * causes.
 *
 * 1. ALIGNMENT. A batched token-classification call returns one array per
 *    input, in input order. Verified in probe_l2_batch_shape.ts: a 4-input
 *    batch returned rows of 19, 16, 3, 3 tokens, where row 0 held
 *    `di ##vy ##a bane ##r ##jee` (= "Divya Banerjee") and row 1 held
 *    `ra ##hul bose 45 ##39 …` (= "Rahul Bose"). So chunk[ri] IS the right
 *    source string for row ri.
 *
 * 2. THE SPAN DIFFERENCE. Rows 2 and 3 returned only 3 tokens each. The model
 *    emits entity tokens plus a little context, so a short or low-signal input
 *    yields almost nothing. That is the same result a per-string call gives —
 *    but per-string calls are made one at a time, and transformers.js appears
 *    to run a SINGLE forward pass per input regardless of batching. If so, the
 *    "batch" saves nothing and adds padding work, which would explain both the
 *    slowdown and the count difference (1070 vs 1074 spans).
 *
 * This script measures (2) directly: same inputs, batch 1 vs batch 6, timed.
 *
 *   npx vite-node bench/probe_l2_batch_perf.ts
 */
import { join } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'

const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE

const N = 120
const TEXTS = Array.from({ length: N }, (_, i) => {
  const n = i % 9
  if (n === 0) return `Contact Divya Banerjee at divya.banerjee@mailbox.net or 6117651412. Ref ${i}.`
  if (n === 1) return `Applicant Rahul Bose, card 4539627187654321, DOB 05/09/1959, ref ${i}.`
  if (n === 2) return `Pune 411001 Anna Salai, order ${i} shipped 06/05.`
  if (n === 3) return `Short note number ${i} with minimal other content here.`
  if (n === 4) return `Terms and conditions apply. Version ${i} of the policy document.`
  if (n === 5) return `Payment received for invoice ${i}, amount due next month.`
  if (n === 6) return `Address line ${i}: 42 Example Street, Sample City 999999.`
  if (n === 7) return `Reference ${i} — no personal data in this sentence at all.`
  return `KYC update required for applicant index ${i} before proceeding further.`
})

type Pipe = (x: string | string[]) => Promise<unknown>

async function timeIt(pipe: Pipe, texts: string[], batch: number): Promise<{ ms: number; rows: number; tokens: number }> {
  const t0 = performance.now()
  let rows = 0
  let tokens = 0
  for (let i = 0; i < texts.length; i += batch) {
    const chunk = texts.slice(i, i + batch)
    const raw = (chunk.length === 1 ? await pipe(chunk[0]!) : await pipe(chunk)) as unknown
    const arr = Array.isArray(raw) ? raw : []
    if (arr.length && Array.isArray(arr[0])) {
      for (const r of arr as unknown[][]) { rows++; tokens += r.length }
    } else {
      rows++; tokens += arr.length
    }
  }
  return { ms: performance.now() - t0, rows, tokens }
}

async function main(): Promise<void> {
  console.log('\n  L2 BATCH PERFORMANCE — does batching actually save time?')
  console.log('  ' + '='.repeat(70))
  console.log(`  ${N} synthetic page strings, ~80 chars each`)

  const pipe = (await pipeline(
    'token-classification',
    'onnx-community/bert-small-pii-detection-ONNX',
    { dtype: 'q8' } as never,
  )) as unknown as Pipe

  await pipe(TEXTS[0]!) // warm

  const results: Array<[number, { ms: number; rows: number; tokens: number }]> = []
  for (const b of [1, 2, 4, 6, 8, 12, 16]) {
    const r = await timeIt(pipe, TEXTS, b)
    results.push([b, r])
    console.log(
      `  batch ${String(b).padStart(2)}: ${r.ms.toFixed(0).padStart(5)} ms  ` +
      `(${(r.ms / N).toFixed(2)} ms/string)  rows=${r.rows} tokens=${r.tokens}`,
    )
  }

  const best = results.reduce((a, b) => (b[1].ms < a[1].ms ? b : a))
  const one = results[0]!
  console.log('  ' + '-'.repeat(70))
  console.log(`  best batch size : ${best[0]}`)
  console.log(`  speedup vs 1    : ${(one[1].ms / best[1].ms).toFixed(2)}x`)
  console.log(`  tokens equal    : ${results.every(([, r]) => r.tokens === one[1].tokens) ? 'YES' : 'NO'}`)
  console.log('  ' + '='.repeat(70))
  if (best[0] === 1) {
    console.log('  FINDING: batching does NOT help this model. transformers.js appears')
    console.log('  to run one forward pass per input regardless of the batch argument, so')
    console.log('  a batch only adds padding work. The honest fix is to keep batch=1 and')
    console.log('  say so, rather than ship a batching layer that costs time.')
  }
}

void main()
