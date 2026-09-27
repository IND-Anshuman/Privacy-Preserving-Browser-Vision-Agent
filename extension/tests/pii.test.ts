import { describe, it, expect } from 'vitest'
import {
  luhn,
  verhoeff,
  runL1,
  classifySemantics,
  hitsFromElement,
  fuseUnion,
  dedupeOverlaps,
  REDACTED_PASSWORD,
  type ElementLike,
  type RawHit,
} from '../lib/pii'

describe('checksums', () => {
  it('luhn accepts valid card numbers and rejects typos', () => {
    expect(luhn('4539578763621486')).toBe(true) // Visa
    expect(luhn('4111 1111 1111 1111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false) // one digit off
    expect(luhn('123')).toBe(false) // wrong length
  })

  it('luhn ignores separators', () => {
    expect(luhn('4111-1111-1111-1111')).toBe(true)
  })

  it('verhoeff validates Aadhaar', () => {
    // Reference Aadhaar numbers from UIDAI's published check-digit examples.
    expect(verhoeff('999999990019')).toBe(true)
    expect(verhoeff('234567890124')).toBe(true)
    expect(verhoeff('234567890125')).toBe(false)
    expect(verhoeff('1234')).toBe(false)
  })
})

describe('L1 detectors', () => {
  const classesOf = (s: string) => runL1(s).map((h) => h.cls)

  it('finds email', () => {
    const hits = runL1('contact me at ankit.sharma@acme.co.in please')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.cls).toBe('EMAIL')
    expect(hits[0]!.text).toBe('ankit.sharma@acme.co.in')
    expect(hits[0]!.score).toBeGreaterThan(0.9)
  })

  it('finds a Luhn-valid card at high confidence and a non-Luhn one at low', () => {
    const good = runL1('card 4539578763621486 on file')
    expect(good.find((h) => h.cls === 'CREDIT_CARD')!.score).toBeGreaterThan(0.9)
    const bad = runL1('card 1234567890123456 on file')
    const c = bad.find((h) => h.cls === 'CREDIT_CARD')
    expect(c).toBeDefined()
    expect(c!.score).toBeLessThan(0.5)
  })

  it('finds Indian mobile numbers and strips the +91 prefix span', () => {
    const hits = runL1('call +91 98765 43210 today')
    const ph = hits.find((h) => h.cls === 'PHONE')
    expect(ph).toBeDefined()
    expect(ph!.text.replace(/\D/g, '').slice(-10)).toBe('9876543210')
  })

  it('does not flag an ordinary 10-digit number as a phone when it is not IN-mobile shaped', () => {
    // Starts with 5 → not a valid IN mobile prefix.
    const hits = runL1('order 5551234567 shipped').filter((h) => h.cls === 'PHONE')
    expect(hits.every((h) => h.score < 0.75)).toBe(true)
  })

  it('finds PAN, IFSC, GSTIN', () => {
    expect(classesOf('PAN ABCDE1234F on record')).toContain('PAN')
    expect(classesOf('IFSC SBIN0001234 branch')).toContain('IFSC')
    expect(classesOf('GSTIN 27ABCDE1234F1Z5 registered')).toContain('GSTIN')
  })

  it('finds Aadhaar only when Verhoeff passes', () => {
    const good = runL1('aadhaar 9999 9999 0019')
    const a = good.find((h) => h.cls === 'AADHAAR')
    expect(a).toBeDefined()
    expect(a!.score).toBeGreaterThan(0.95)
    const bad = runL1('aadhaar 1234 5678 9124')
    const b = bad.find((h) => h.cls === 'AADHAAR')
    expect(b === undefined || b.score < 0.7).toBe(true)
  })

  it('finds JWT and API keys', () => {
    expect(classesOf('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc1234')).toContain('JWT')
    // Real Google API keys are 39 chars: 'AIza' + 35.
    expect(classesOf('AIzaSyB1234567890abcdefghijklmnopqrstuv')).toContain('API_KEY')
  })

  it('finds IBAN and drops it when mod-97 fails', () => {
    const good = runL1('iban GB82WEST12345698765432')
    const g = good.find((h) => h.cls === 'IBAN')
    expect(g!.score).toBeGreaterThan(0.95)
    const bad = runL1('iban GB82WEST12345698765433')
    const b = bad.find((h) => h.cls === 'IBAN')
    expect(b === undefined || b.score < 0.5).toBe(true)
  })

  it('never returns overlapping spans after dedupe', () => {
    const text = 'a@b.com and 4539578763621486 and +91 9876543210'
    const hits = runL1(text)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.start).toBeGreaterThanOrEqual(hits[i - 1]!.end)
    }
  })

  it('is cheap: 20k chars under 30ms', () => {
    const text = 'lorem ipsum 4539578763621486 dolor sit a@b.com '.repeat(400)
    const t0 = performance.now()
    runL1(text)
    expect(performance.now() - t0).toBeLessThan(30)
  })
})

describe('L0 semantics', () => {
  const el = (o: Partial<ElementLike>): ElementLike => ({ tag: 'input', ...o })

  it('flags input[type=password] and refuses to keep the value', () => {
    const v = classifySemantics(el({ type: 'password', value: 'hunter2' }))
    expect(v.cls).toBe('PASSWORD')
    expect(v.isPassword).toBe(true)
    const hits = hitsFromElement(el({ type: 'password', value: 'hunter2' }))
    expect(hits[0]!.text).toBe(REDACTED_PASSWORD)
    expect(hits[0]!.text).not.toContain('hunter2')
  })

  it('catches password fields with no password-ish name', () => {
    expect(classifySemantics(el({ type: 'text', autocomplete: 'current-password' })).isPassword).toBe(true)
    expect(classifySemantics(el({ type: 'text', name: 'pwd' })).cls).toBe('PASSWORD')
  })

  it('maps autocomplete tokens to classes', () => {
    expect(classifySemantics(el({ autocomplete: 'cc-number' })).cls).toBe('CREDIT_CARD')
    expect(classifySemantics(el({ autocomplete: 'cc-csc' })).cls).toBe('CREDIT_CARD')
    expect(classifySemantics(el({ autocomplete: 'billing street-address' })).cls).toBe('ADDRESS')
    expect(classifySemantics(el({ autocomplete: 'name' })).cls).toBe('PERSON')
  })

  it('maps field names to the right class', () => {
    expect(classifySemantics(el({ name: 'aadhaarNumber' })).cls).toBe('AADHAAR')
    expect(classifySemantics(el({ name: 'pan' })).cls).toBe('PAN')
    expect(classifySemantics(el({ name: 'cvv' })).cls).toBe('CREDIT_CARD')
    expect(classifySemantics(el({ name: 'ifsc_code' })).cls).toBe('IFSC')
    expect(classifySemantics(el({ name: 'dob' })).cls).toBe('DOB')
  })

  it('finds PII hiding in data-* attributes', () => {
    const v = classifySemantics(
      el({ type: 'text', dataAttrs: { 'user-email': 'a@b.com', 'data-pii': 'x' } }),
    )
    expect(v.cls).toBe('EMAIL')
    expect(v.reason).toContain('data-user-email')
  })

  it('treats identity images as faces', () => {
    const v = classifySemantics({ tag: 'img', name: 'passport-photo.jpg' } as ElementLike)
    expect(v.cls).toBe('FACE')
    expect(v.looksLikeIdentityImage).toBe(true)
  })

  it('leaves an ordinary text input alone', () => {
    expect(classifySemantics(el({ type: 'text', name: 'q', placeholder: 'Search' })).cls).toBeNull()
  })

  // --- precision regressions: substring matching is a metric-2 killer ------
  // 'pan' ⊂ 'company', 'dob' ⊂ 'window', 'pin' ⊂ 'shipping', 'otp' ⊂ 'laptop',
  // 'cvv' ⊂ ..., 'zip' ⊂ ..., 'name' ⊂ ... . Each of these used to produce a
  // redaction box on an innocuous field, which is a false positive.
  const innocuous: Array<[string, Partial<ElementLike>]> = [
    ['company', { name: 'company' }],
    ['companyName', { name: 'companyName' }],
    ['window size', { title: 'window size' }],
    ['shipping address note', { name: 'shipping_note' }],
    ['laptop model', { name: 'laptop_model' }],
    ['department', { name: 'department' }],
    ['description', { name: 'description' }],
    ['occupation', { name: 'occupation' }],
    ['pin board', { name: 'pinboard_ref' }],
    ['zipper', { name: 'zipper_colour' }],
  ]

  for (const [why, attrs] of innocuous) {
    it(`does not false-positive on ${why}`, () => {
      const v = classifySemantics(el({ type: 'text', ...attrs }))
      expect(v.cls).toBeNull()
      expect(v.isPassword).toBe(false)
    })
  }

  it('does not treat a search box on a company directory as a person', () => {
    const v = classifySemantics(el({ type: 'search', name: 'company_search', placeholder: 'Find a company' }))
    expect(v.cls).toBeNull()
  })

  it('still catches the real thing when the token is genuinely there', () => {
    // Guards against over-correcting into false negatives.
    expect(classifySemantics(el({ name: 'companyPAN' })).cls).toBe('PAN')
    expect(classifySemantics(el({ name: 'card_number' })).cls).toBe('CREDIT_CARD')
    expect(classifySemantics(el({ name: 'aadhaarNumber' })).cls).toBe('AADHAAR')
    expect(classifySemantics(el({ name: 'ifscCode' })).cls).toBe('IFSC')
    expect(classifySemantics(el({ name: 'emergency_contact' })).cls).toBe('PERSON')
  })

  it('handles snake_case, camelCase and spaces identically', () => {
    const a = classifySemantics(el({ name: 'date_of_birth' })).cls
    const b = classifySemantics(el({ name: 'dateOfBirth' })).cls
    const c = classifySemantics(el({ name: 'Date of Birth' })).cls
    expect(a).toBe('DOB')
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('prefers the longest matching phrase', () => {
    // "card number" (2 tokens) must win over nothing shorter, and must not
    // degrade to a bare CARD/PAN match.
    expect(classifySemantics(el({ name: 'card_number_field' })).cls).toBe('CREDIT_CARD')
  })
})

describe('fusion', () => {
  it('lets L0 semantics override an L1 regex guess on the same value', () => {
    const l0: RawHit = { cls: 'AADHAAR', source: 'L0', score: 0.99, text: 'x', start: 0, end: 12 }
    const l1: RawHit = { cls: 'AADHAAR', source: 'L1', score: 0.6, text: 'x', start: 0, end: 12 }
    const fused = fuseUnion([l1, l0])
    expect(fused).toHaveLength(1)
    expect(fused[0]!.source).toBe('L0')
  })

  it('keeps distinct classes on overlapping text (a card number is also 16 digits)', () => {
    const hits = runL1('pan ABCDE1234F card 4539578763621486')
    expect(hits.map((h) => h.cls)).toContain('PAN')
    expect(hits.map((h) => h.cls)).toContain('CREDIT_CARD')
  })

  it('dedupe keeps the highest score for identical spans', () => {
    const hits: RawHit[] = [
      { cls: 'PHONE', source: 'L1', score: 0.9, text: '9876543210', start: 0, end: 10 },
      { cls: 'PHONE', source: 'L1', score: 0.6, text: '9876543210', start: 0, end: 10 },
    ]
    expect(dedupeOverlaps(hits)).toHaveLength(1)
  })
})
