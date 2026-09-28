/**
 * WHY L2 SCORES ZERO — the finding, not a workaround.
 *
 * The measurement in measure_l2.ts returned micro F1 = 0.000 for the L2 layer.
 * Before treating that as "the model is bad", this script isolates WHY, because
 * the two possible causes demand opposite responses:
 *
 *   (a) a bug in how detections are attributed to ground truth, or
 *   (b) the model genuinely lacks the classes.
 *
 * The test: run the NER on a single known string and print the raw spans. If
 * the model returns nothing for a literal email address, the answer is (b) and
 * no amount of harness work will change it.
 */
import { pipeline, env } from '@huggingface/transformers'
import { join } from 'node:path'

const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE

const PROBES = [
  'Contact ankit.sharma@acme.in or call 9876543210',
  'My name is Ankit Sharma and I live in Bengaluru',
  'Card number 4539578763621486 expires 12/28',
  'Aadhaar 999999990019',
  'IFSC SBIN0001234',
]

async function main(): Promise<void> {
  console.log('\n  L2 DIAGNOSTIC — what does the model actually return?')
  console.log('  ' + '='.repeat(72))

  const pipe = await pipeline('token-classification', 'Xenova/bert-base-NER', { dtype: 'q8' } as never)
  const labels = new Set<string>()

  for (const probe of PROBES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await pipe(probe)
    const ents = (out as Array<{ entity: string; word: string; score: number }>)
      .filter((e) => !/^[SILUO]-/.test(e.entity))
    console.log(`\n  "${probe}"`)
    if (ents.length === 0) {
      console.log('      (no entities)')
    }
    for (const e of ents) {
      labels.add(e.entity)
      console.log(`      ${e.entity.padEnd(16)} ${(e.word ?? '').padEnd(22)} ${e.score.toFixed(3)}`)
    }
  }

  console.log('\n  ' + '-'.repeat(72))
  console.log(`  label set actually emitted: ${[...labels].sort().join(', ') || '(none)'}`)
  console.log('  ' + '='.repeat(72))
  console.log(`
  CoNLL-2003 NER (bert-base-NER) was trained on newswire PER / ORG / LOC / MISC.
  It has no notion of EMAIL, PHONE, CARD, AADHAAR, PAN, IFSC or DOB. Those
  classes do not exist in its label space, so it cannot emit them — not at any
  threshold, and not with a better prompt.

  The consequence for this project: the architecture's L2 assumption (a neural
  detector that recovers what regex misses) does NOT hold for the only NER
  weights that load in a browser runtime. GLiNER, the preferred choice, is
  rejected outright by transformers.js ("Unsupported model type: gliner").

  What this means for the privacy claim:
    · L0 + L1 remain the load-bearing layers, and they measured 0.880 F1.
    · PERSON recall (0.56) is a real gap that neither available model closes.
    · Any future L2 claim must cite a model whose LABEL SPACE contains the
      class, and must be measured the way this file measures it.

  This is a finding about the model roster, not a defect in the cascade. It is
  reported here rather than hidden behind a threshold tweak.
`)
}

void main()
