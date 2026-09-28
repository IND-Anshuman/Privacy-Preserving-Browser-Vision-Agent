import { describe, it, expect } from 'vitest'
import {
  L2_TAU,
  admitL2,
  l2Enabled,
  l2Status,
  enabledL2Classes,
  l1CoversIt,
} from '../lib/l2policy'
import {
  recoverOffsets, normaliseRows, mergeTokens, MODEL_IDS, MODEL_FINDINGS,
} from '../entrypoints/offscreen/models'
import { mapL2Label, PII_MODEL_LABELS } from '../entrypoints/offscreen/ner'

/**
 * These lock in MEASURED decisions, not preferences.
 * Source: bench/measure_pii_l2.ts and bench/tune_pii_thresholds.ts.
 */
describe('L2 policy — measured operating point', () => {
  it('enables L2 for PERSON only, because that is what the sweep found', () => {
    expect(enabledL2Classes()).toEqual(['PERSON'])
  })

  it('rejects LOCATION at any confidence — it produced 337 false positives', () => {
    expect(admitL2('LOCATION', 0.99)).toBe(false)
  })

  it('admits a confident PERSON span and rejects a weak one', () => {
    expect(admitL2('PERSON', 0.995)).toBe(true)
    expect(admitL2('PERSON', 0.98)).toBe(false)
  })

  it('does not run L2 when pressure forbids it, so the model is never downloaded', () => {
    expect(l2Enabled(false)).toBe(false)
    expect(l2Enabled(true)).toBe(true) // one class is enabled
  })

  it('explains itself', () => {
    expect(l2Status()).toContain('PERSON')
  })

  it('never enables a class L1 already owns exactly', () => {
    // Email and phone are regex-exact; the measured gain from L2 was zero.
    expect(L2_TAU['EMAIL']).toBeGreaterThan(1)
    expect(L2_TAU['PHONE']).toBeGreaterThan(1)
  })
})

describe('model ids are the corrected ones', () => {
  it('uses the PII model, not the CoNLL one that cannot detect PII', () => {
    expect(MODEL_IDS.l2).toBe('onnx-community/bert-small-pii-detection-ONNX')
    expect(MODEL_IDS.l2).not.toContain('bert-base-NER')
  })

  it('ships the detector that was measured to run fastest', () => {
    // This assertion is deliberately on the MEASUREMENT rather than on a
    // literal model id, so it survives the next re-evaluation. The table in
    // MODEL_FINDINGS.detectorTable is the evidence; the test just refuses to
    // regress below the runner-up.
    const table = MODEL_FINDINGS.detectorTable
    const shipped = table.find((r) => r.repo === MODEL_IDS.l3face)
    expect(shipped, `${MODEL_IDS.l3face} is not in the measured table`).toBeTruthy()
    expect(shipped!.runs, 'the shipped detector does not run').toBe(true)

    const runners = table.filter((r) => r.runs && typeof r.warmMs === 'number')
    const best = runners.reduce((a, b) => (b.warmMs! < a.warmMs! ? b : a))
    expect(MODEL_IDS.l3face).toBe(best.repo)
    // And it must be materially smaller than the one it replaced.
    const old = table.find((r) => r.repo.includes('detr-resnet-50'))
    expect(shipped!.q8Mb).toBeLessThan(old!.q8Mb)
  })

  it('records that the 2.65 MB recommendation does not run', () => {
    // yolov10n resolves, downloads, and has a full COCO id2label — and still
    // cannot execute in transformers.js. Pinning that keeps a future "just use
    // the small one" from repeating the experiment.
    expect(MODEL_FINDINGS.yolov10).toBe('unsupported-by-transformers-js')
    for (const bad of MODEL_FINDINGS.rejected) {
      expect(MODEL_IDS.l3face).not.toContain(bad.split('/')[1]!)
    }
  })
})

describe('offset recovery — the measured API returns NO offsets', () => {
  const src = 'Contact Divya Banerjee now'

  it('reconstructs offsets from wordpiece fragments', () => {
    const toks = [
      { entity: 'O', score: 0, word: '[CLS]', start: null, end: null, index: 0 },
      { entity: 'B-PERSON', score: 0.9, word: 'Div', start: null, end: null, index: 1 },
      { entity: 'I-PERSON', score: 0.9, word: '##ya', start: null, end: null, index: 2 },
    ]
    const out = recoverOffsets(toks, src)
    // [CLS] dropped; both fragments keep their own offsets so the merge can
    // join them. 'Div' is at 8 and '##ya' is the continuation at 11.
    expect(out).toHaveLength(2)
    expect(out[0]!.start).toBe(8)
    expect(out[1]!.start).toBe(11)
    expect(src.slice(out[0]!.start!, out[1]!.end!)).toBe('Divya')
  })

  it('drops special tokens', () => {
    const toks = [
      { entity: 'O', score: 0, word: '[CLS]', start: null, end: null, index: 0 },
      { entity: 'O', score: 0, word: '[SEP]', start: null, end: null, index: 1 },
    ]
    expect(recoverOffsets(toks, src)).toHaveLength(0)
  })

  it('drops an unmappable fragment rather than guessing an offset', () => {
    const toks = [{ entity: 'B-PERSON', score: 0.9, word: 'ZZZ', start: null, end: null, index: 1 }]
    expect(recoverOffsets(toks, src)).toHaveLength(0)
  })

  it('preserves offsets the caller already supplied', () => {
    const toks = [{ entity: 'B-PERSON', score: 0.9, word: 'Divya', start: 8, end: 13, index: 1 }]
    const out = recoverOffsets(toks, src)
    expect(out[0]!.start).toBe(8)
    expect(out[0]!.end).toBe(13)
  })
})

describe('row normalisation', () => {
  const tok = (w: string) => ({ entity: 'B-PERSON', score: 0.9, word: w, start: null, end: null, index: 0 })

  it('wraps a flat token list into one row', () => {
    expect(normaliseRows([tok('a'), tok('b')])).toHaveLength(1)
  })

  it('passes a nested list through', () => {
    const nested = [[tok('a')], [tok('b')]]
    expect(normaliseRows(nested)).toHaveLength(2)
  })

  it('returns nothing for an empty or non-array result', () => {
    expect(normaliseRows([])).toHaveLength(0)
    expect(normaliseRows(null)).toHaveLength(0)
  })
})

describe('end-to-end span reconstruction on a real sentence', () => {
  it('produces the exact entity text the model saw', () => {
    const src = 'Applicant: Divya Banerjee. Contact divya.banerjee@mailbox.net.'
    const toks = [
      { entity: 'O', score: 0, word: '[CLS]', start: null, end: null, index: 0 },
      { entity: 'B-PERSON', score: 0.98, word: 'Div', start: null, end: null, index: 1 },
      { entity: 'I-PERSON', score: 0.98, word: '##ya', start: null, end: null, index: 2 },
    ]
    const spans = mergeTokens(recoverOffsets(toks, src), src)
    // 'Div' is at 11 and '##ya' continues at 14, so the run covers "Divya".
    expect(spans).toHaveLength(1)
    expect(spans[0]!.start).toBe(11)
    expect(src.slice(spans[0]!.start, spans[0]!.end)).toBe('Divya')
    expect(mapL2Label(spans[0]!.label)).toBe('PERSON')
  })
})

describe('taxonomy mapping covers the model', () => {
  it('maps every class except the two we deliberately refuse', () => {
    for (const l of PII_MODEL_LABELS) {
      if (l === 'URL' || l === 'TITLE') expect(mapL2Label(l), l).toBeNull()
      else expect(mapL2Label(l), l).not.toBeNull()
    }
  })
})

/* ==================================================================== *
 *  l1CoversIt — the input-reduction filter
 *
 *  This is the M5 lever that actually worked: 60.3% less wall clock, zero
 *  admitted spans lost (bench/results/l2_input_reduction.json). It replaced
 *  batching, which was measured at 1.20x with a batch-size-dependent token
 *  count and rejected.
 *
 *  The contract is narrow and these tests hold it to that: skip a string ONLY
 *  when L1 already owns its PII AND it holds nothing that looks like a name.
 *  PERSON is the only admitted class, so a name is the only thing L2 could
 *  possibly add.
 * ==================================================================== */
describe('l1CoversIt — input reduction', () => {
  it('skips a string whose only PII is an L1-owned format', () => {
    expect(l1CoversIt('divya.banerjee@mailbox.net')).toBe(true)
    expect(l1CoversIt('6117651412')).toBe(true)
    expect(l1CoversIt('ABCDE1234F')).toBe(true)
    expect(l1CoversIt('4111 1111 1111 1111')).toBe(true)
    expect(l1CoversIt('2345 6789 0123')).toBe(true)
  })

  it('refuses to skip a string that also contains a name', () => {
    // This is the whole point. A name is the only class L2 is admitted for, so
    // a string with L1-owned PII *and* a name must still go to the model.
    expect(l1CoversIt('Divya Banerjee — divya.banerjee@mailbox.net')).toBe(false)
    expect(l1CoversIt('Contact Rahul Bose at 6117651412')).toBe(false)
  })

  it('refuses to skip a string with no L1-owned format at all', () => {
    // Nothing L1 matches means nothing is already covered, so there is no
    // justification for skipping — even without a name. A bare value here
    // could be a name the model would catch.
    expect(l1CoversIt('some ordinary sentence with no identifiers')).toBe(false)
    expect(l1CoversIt('')).toBe(false)
  })

  it('does not treat a lowercase sentence as a name', () => {
    // The name test is case-sensitive on purpose: "email address" must not
    // read as a person, or every label on a form would defeat the filter.
    expect(l1CoversIt('email address — 6117651412')).toBe(true)
  })

  it('leaves every string the corpus relies on unskipped when a name is present', () => {
    // Guards the direction that matters: over-skipping loses recall silently.
    const risky = [
      'Applicant: Divya Banerjee',
      'PAN ABCDE1234F holder Rahul Bose',
      'Contact person Anna Salai, phone 9876543210',
    ]
    for (const s of risky) expect(l1CoversIt(s)).toBe(false)
  })
})
