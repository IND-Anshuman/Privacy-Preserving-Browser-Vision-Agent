import { describe, it, expect } from 'vitest'
import { mergeTokens } from '../entrypoints/offscreen/models'
import { mapL2Label, PII_MODEL_LABELS } from '../entrypoints/offscreen/ner'

/**
 * The model returns flat tokens with NO offsets in this build (measured —
 * see bench/probe_pii_raw.ts). These tests pin the merge behaviour that the
 * corpus benchmark depends on, without loading a 27 MB model.
 */
const tok = (
  entity: string,
  word: string,
  start: number,
  end: number,
  score = 0.9,
) => ({ entity, score, word, start, end, index: 0 })

describe('subword merge', () => {
  const src = 'Contact Divya Banerjee at x'

  it('joins B-/I- runs of the same label into one span', () => {
    const spans = mergeTokens(
      [tok('B-PERSON', 'Div', 8, 11), tok('I-PERSON', '##ya', 11, 14, 0.98)],
      src,
    )
    expect(spans).toHaveLength(1)
    expect(spans[0]!.label).toBe('PERSON')
    expect(spans[0]!.text).toBe('Divya')
  })

  it('does not join different labels', () => {
    const spans = mergeTokens(
      [tok('B-PERSON', 'Div', 8, 11), tok('B-LOCATION', 'Banerjee', 12, 20)],
      src,
    )
    expect(spans.map((s) => s.label).sort()).toEqual(['LOCATION', 'PERSON'])
  })

  it('closes a run on O', () => {
    const spans = mergeTokens(
      [tok('B-PERSON', 'Div', 8, 11), tok('I-PERSON', '##ya', 11, 14), tok('O', 'at', 0, 0)],
      src,
    )
    expect(spans).toHaveLength(1)
  })

  it('takes the weakest score in a run, so a bad tail lowers the span', () => {
    const spans = mergeTokens(
      [tok('B-PERSON', 'Div', 8, 11, 0.99), tok('I-PERSON', '##ya', 11, 14, 0.38)],
      src,
    )
    expect(spans[0]!.score).toBe(0.38)
  })

  it('reconstructs the exact substring from the source', () => {
    const spans = mergeTokens(
      [tok('B-EMAIL_ADDRESS', 'a@b', 0, 4), tok('I-EMAIL_ADDRESS', '.co', 4, 7)],
      'a@b.co rest',
    )
    expect(spans[0]!.text).toBe('a@b.co')
  })

  it('drops labels we deliberately do not map', () => {
    const spans = mergeTokens([tok('B-URL', 'https', 0, 5)], 'https rest')
    expect(spans).toHaveLength(0)
  })

  it('handles a non-contiguous run as two spans', () => {
    const spans = mergeTokens(
      [tok('B-PERSON', 'Div', 8, 11), tok('I-PERSON', '##ya', 30, 33)],
      src,
    )
    expect(spans).toHaveLength(2)
  })
})

describe('taxonomy mapping', () => {
  it('maps every PII class the model can emit, or returns null deliberately', () => {
    for (const label of PII_MODEL_LABELS) {
      const m = mapL2Label(label)
      const shouldMap = !['URL', 'TITLE'].includes(label)
      if (shouldMap) expect(m, label).not.toBeNull()
    }
  })

  it('accepts B- and I- prefixes', () => {
    expect(mapL2Label('B-PERSON')).toBe('PERSON')
    expect(mapL2Label('I-EMAIL_ADDRESS')).toBe('EMAIL')
  })

  it('maps the classes that matter most to this corpus', () => {
    expect(mapL2Label('PERSON')).toBe('PERSON')
    expect(mapL2Label('EMAIL_ADDRESS')).toBe('EMAIL')
    expect(mapL2Label('PHONE_NUMBER')).toBe('PHONE')
    expect(mapL2Label('CREDIT_CARD')).toBe('CREDIT_CARD')
    expect(mapL2Label('PASSWORD')).toBe('PASSWORD')
    expect(mapL2Label('US_SSN')).toBe('AADHAAR')
    expect(mapL2Label('ORGANIZATION')).toBe('ORG')
  })

  it('refuses to redact a bare URL or an honorific', () => {
    // Over-redacting every link would make the redacted frame useless.
    expect(mapL2Label('URL')).toBeNull()
    expect(mapL2Label('TITLE')).toBeNull()
  })

  it('returns null for an unknown label rather than guessing', () => {
    expect(mapL2Label('SOMETHING_ELSE')).toBeNull()
  })
})
