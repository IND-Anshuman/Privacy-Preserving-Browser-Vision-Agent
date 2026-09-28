import { describe, it, expect } from 'vitest'
import { Pseudonymizer, PASSWORD_TOKEN } from '../lib/pseudonym'
import { PlaceholderSchema } from '../lib/schema'

/**
 * Co-reference across contexts — the invariant that was silently broken.
 *
 * The content script and the offscreen compositor are SEPARATE JS contexts. Each
 * constructed its own Pseudonymizer, and the salt and the token tag were both
 * random PER INSTANCE. So one person became `[PERSON_A3_1]` in
 * screen_state.json and `[PERSON_F7_1]` in the manifest. The server, whose job
 * is to reason about relationships between fields, could not tell those were
 * the same entity — and the architecture's "same entity → same token" claim was
 * false for exactly the pair of artefacts that have to agree.
 *
 * It was also unstable across runs: the suffix was a sequence counter, so the
 * same person was `[PERSON_A3_2]` if another PERSON happened to be detected
 * first and `[PERSON_A3_5]` otherwise.
 */
describe('co-reference across the two channels', () => {
  it('two independent instances on the same session mint identical tokens', () => {
    // This simulates content.ts and redact.ts, which are different contexts.
    const dom = new Pseudonymizer('sess-abc-123')
    const compositor = new Pseudonymizer('sess-abc-123')

    const values: Array<[string, 'PERSON' | 'EMAIL' | 'PHONE']> = [
      ['Divya Banerjee', 'PERSON'],
      ['divya.banerjee@mailbox.net', 'EMAIL'],
      ['6117651412', 'PHONE'],
    ]
    for (const [v, c] of values) {
      expect(dom.tokenFor(v, c).token, v).toBe(compositor.tokenFor(v, c).token)
    }
  })

  it('is order-independent — walk order must not change a token', () => {
    // The content script walks the DOM in document order; the compositor walks
    // the detection list. Different orders, same tokens.
    const a = new Pseudonymizer('sess-order')
    const b = new Pseudonymizer('sess-order')

    const first = a.tokenFor('Zoe Quaid', 'PERSON').token
    a.tokenFor('Arjun Khan', 'PERSON')
    a.tokenFor('6117651412', 'PHONE')

    const second = b.tokenFor('6117651412', 'PHONE').token
    b.tokenFor('Zoe Quaid', 'PERSON')
    b.tokenFor('Arjun Khan', 'PERSON')

    expect(first).toBe(b.tokenFor('Zoe Quaid', 'PERSON').token)
    expect(second).toBe(b.tokenFor('6117651412', 'PHONE').token)
  })

  it('is stable across separate runs, not just within one', () => {
    // Deterministic by construction: same session id → same token. This is a
    // regression guard on the previous random-salt design.
    const first = new Pseudonymizer('sess-stable').tokenFor('Rahul Bose', 'PERSON').token
    const second = new Pseudonymizer('sess-stable').tokenFor('Rahul Bose', 'PERSON').token
    expect(first).toBe(second)
  })

  it('different sessions still produce different tokens', () => {
    // Cross-session unlinkability must survive the determinism fix, otherwise
    // two transcripts could be joined on a shared token.
    const a = new Pseudonymizer('sess-one').tokenFor('Rahul Bose', 'PERSON').token
    const b = new Pseudonymizer('sess-two').tokenFor('Rahul Bose', 'PERSON').token
    expect(a).not.toBe(b)
  })

  it('never emits the same token for two different people in a session', () => {
    const p = new Pseudonymizer('sess-uniq')
    const seen = new Set<string>()
    for (const n of ['Arjun Khan', 'Rahul Bose', 'Divya Banerjee', 'Karan Verma', 'Neha Rao']) {
      const t = p.tokenFor(n, 'PERSON').token
      expect(seen.has(t), `collision on ${n}`).toBe(false)
      seen.add(t)
    }
    expect(seen.size).toBe(5)
  })
})

describe('passwords are categorically exempt', () => {
  it('emits the fixed token and never a hash-derived one', () => {
    const p = new Pseudonymizer('sess-pw')
    expect(p.tokenFor('hunter2', 'PASSWORD').token).toBe(PASSWORD_TOKEN)
    expect(PASSWORD_TOKEN).toBe('[PASSWORD]')
  })

  it('does not hold the secret in a map key', () => {
    // Keying PASSWORD on the value would retain the secret for the session.
    const p = new Pseudonymizer('sess-pw2')
    const a = p.tokenFor('correct horse battery staple', 'PASSWORD').token
    const b = p.tokenFor('a completely different secret', 'PASSWORD').token
    expect(a).toBe(b)
  })
})

describe('tokens satisfy the wire schema', () => {
  it('every minted token passes PlaceholderSchema', () => {
    // A token the server rejects is a 422 on a real run, so this is a
    // contract test rather than a formatting nicety.
    const p = new Pseudonymizer('sess-wire')
    for (const [v, c] of [
      ['Divya Banerjee', 'PERSON'],
      ['divya.banerjee@mailbox.net', 'EMAIL'],
      ['834287209634', 'AADHAAR'],
      ['QRFCU3629K', 'PAN'],
      ['4539627187654321', 'CREDIT_CARD'],
      ['x', 'PASSWORD'],
    ] as const) {
      const t = p.tokenFor(v, c as never)
      const r = PlaceholderSchema.safeParse({ token: t.token, cls: t.cls })
      expect(r.success, `${t.token} rejected: ${r.success ? '' : r.error.message}`).toBe(true)
    }
  })
})

describe('contiguity bridging still holds', () => {
  it('merges "Divya" + "Banerjee" into one redacted region', () => {
    // The model returns subwords; substituting them independently leaves the
    // surname readable, which was a real leak.
    const p = new Pseudonymizer('sess-bridge')
    const src = 'Applicant: Divya Banerjee filed it'
    const out = p.substitute(src, [
      { start: 11, end: 16, cls: 'PERSON', text: 'Divya' },
      { start: 17, end: 25, cls: 'PERSON', text: 'Banerjee' },
    ])
    expect(out).not.toContain('Divya')
    expect(out).not.toContain('Banerjee')
    expect(out).toMatch(/Applicant: \[PERSON_[A-Z0-9]+_[0-9a-f]+\] filed it/)
  })
})
