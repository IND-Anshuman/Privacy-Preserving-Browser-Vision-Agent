import { describe, it, expect } from 'vitest'
import {
  L2_TAU,
  admitL2,
  l2Enabled,
  l2Status,
  enabledL2Classes,
} from '../lib/l2policy'
import { recoverOffsets, normaliseRows, mergeTokens, MODEL_IDS } from '../entrypoints/offscreen/models'
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

  it('uses the small NMS-free face detector rather than the 43 MB DETR', () => {
    expect(MODEL_IDS.l3face).toBe('onnx-community/yolov10n')
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
