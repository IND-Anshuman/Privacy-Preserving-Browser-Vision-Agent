/**
 * What does a BATCHED token-classification call actually return?
 *
 * The batched L2 path produced spans that were fragments of the wrong words —
 * `PERSON|Aa`, `ORGANIZATION|ue`, `PERSON|Des` — which is the signature of a
 * row's offsets being applied to a source string that did not produce it. Two
 * possible causes, and they need different fixes:
 *
 *   a) the batch returns ONE flat list, concatenated, with no row boundary — so
 *      `chunk[ri]` is simply the wrong string for every row after the first;
 *   b) the batch returns one list per input, but the ORDER differs, or rows are
 *      dropped for inputs that produced no tokens.
 *
 * (a) means batching is unusable for this model. (b) means the row mapping needs
 * to be derived rather than assumed.
 *
 *   npx vite-node bench/probe_l2_batch_shape.ts
 */
import { join } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'

const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE

const TEXTS = [
  'Contact Divya Banerjee at divya.banerjee@mailbox.net or 6117651412.',
  'Applicant: Rahul Bose. Card 4539627187654321 expires 05/09/1959.',
  'The quick brown fox jumps over the lazy dog near Pune 411001.',
  'Total 150 items shipped on 06/05 to Anna Salai.',
]

async function main(): Promise<void> {
  console.log('\n  L2 BATCH SHAPE — how does a multi-input call return rows?')
  console.log('  ' + '='.repeat(70))
  const pipe = (await pipeline(
    'token-classification',
    'onnx-community/bert-small-pii-detection-ONNX',
    { dtype: 'q8' } as never,
  )) as unknown as (x: string | string[]) => Promise<unknown>

  // Single input, for the baseline.
  const one = (await pipe(TEXTS[0]!)) as unknown[]
  console.log(`\n  single input  -> top-level array of ${one.length}`)
  console.log(`    first element is array? ${Array.isArray(one[0])}`)
  console.log(`    sample: ${JSON.stringify((one as Record<string, unknown>[]).slice(0, 2))}`)

  // Two inputs.
  const two = (await pipe(TEXTS.slice(0, 2))) as unknown
  const twoArr = two as unknown[][]
  console.log(`\n  two inputs    -> top-level array of ${twoArr.length}`)
  console.log(`    rows: ${twoArr.map((r) => (Array.isArray(r) ? r.length : 'NOT AN ARRAY')).join(', ')}`)
  for (let i = 0; i < Math.min(2, twoArr.length); i++) {
    const row = twoArr[i] as Record<string, unknown>[]
    const first = row?.[0]
    console.log(`    row ${i} first token: ${JSON.stringify(first)}`)
  }

  // Four inputs — the size production actually uses.
  const four = (await pipe(TEXTS)) as unknown[][]
  console.log(`\n  four inputs   -> top-level array of ${four.length}`)
  console.log(`    rows: ${four.map((r) => (Array.isArray(r) ? r.length : 'NOT AN ARRAY')).join(', ')}`)

  // THE DECISIVE TEST: does row i's text correspond to input i?
  console.log('\n  row→input alignment (looking for a distinctive word per input):')
  const marker = ['divya', 'rahul', 'fox', 'anna']
  four.forEach((row, i) => {
    const words = ((row as Record<string, string>[]) ?? []).map((t) => t.word ?? '').join(' ')
    const has = marker[i] ? words.toLowerCase().includes(marker[i]!) : false
    console.log(
      `    row ${i} expects "${marker[i]}" -> ${has ? 'ALIGNED' : 'MISALIGNED'}` +
      `  (row words: ${words.slice(0, 58)})`,
    )
  })
  console.log('  ' + '='.repeat(70))
}

void main()
