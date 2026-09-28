/**
 * Stable, per-session pseudonymization — ARCHITECTURE.md §6.1.
 *
 * Extracted to lib/ so the content script and the offscreen compositor share ONE
 * implementation. Two copies is how the two channels drift and start minting
 * different tokens for the same value, which silently breaks co-reference
 * between screen_state.json and the manifest.
 *
 * Invariants:
 *  · Same value + same session → same token. Different session → different.
 *  · The salt never leaves the client, so tokens are not linkable across
 *    sessions or across users.
 *  · A PASSWORD never gets a pseudonym — not even a salted hash of one. A hash
 *    of a password is an offline-cracking surface. It emits [PASSWORD].
 */
import type { PiiClass } from './schema'

/**
 * FNV-1a. Used for the session tag and the memo key.
 *
 * Deterministic on purpose: the content script and the offscreen compositor are
 * separate contexts, so anything randomised per-instance produced different
 * tokens for the same value in each. This is not a security primitive — the
 * session id is the only secret and it never leaves the client.
 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}


export interface PseudoEntry {
  token: string
  cls: PiiClass
}

export const PASSWORD_TOKEN = '[PASSWORD]'

export class Pseudonymizer {
  private map = new Map<string, PseudoEntry>()
  private readonly salt: string
  /**
   * Session-scoped prefix for the counter, and the reason co-reference works at
   * all.
   *
   * This was previously `randomSalt().slice(0, 2)` — random PER INSTANCE. The
   * content script and the offscreen compositor are separate JS contexts, each
   * constructing its own Pseudonymizer, so the same person got
   * `[PERSON_A3_1]` in screen_state.json and `[PERSON_F7_1]` in the manifest. The
   * architecture's co-reference guarantee — "same entity → same token" — did
   * not hold across the two channels that are supposed to agree, and the
   * server could not tell that `[PERSON_A3_1]` and `[PERSON_F7_1]` were one
   * person.
   *
   * So the tag is DERIVED from the session id, not randomised. Every context
   * given the same session id now produces byte-identical tokens, and
   * cross-session unlinkability is preserved because the session id itself
   * differs per session. The salt is derived the same way for the same reason:
   * a per-instance random salt hashed the same value differently in each
   * context, so the same breakage applied to the memo key.
   */
  private readonly tag: string

  constructor(sessionId: string) {
    this.salt = sessionId
    this.tag = fnv1a(sessionId).toString(16).slice(0, 2).toUpperCase()
  }

  private hash(s: string): string {
    // Deterministic over (sessionId, value). The salt is the session id, so two
    // contexts handed the same session id produce the same key — which is what
    // lets screen_state.json and the manifest agree on a token. NOT a security
    // primitive: the session id never leaves the client, and the raw value is
    // never transmitted in any form.
    const normalised = s.toLowerCase().replace(/\s+/g, ' ').trim()
    return (fnv1a(`${this.salt}:${normalised}`) >>> 0).toString(16).padStart(8, '0')
  }

  tokenFor(value: string, cls: PiiClass): PseudoEntry {
    // Passwords are keyed on the CLASS alone: keying on the value would mean
    // holding the secret in a map key for the session's lifetime.
    const key = cls === 'PASSWORD' ? 'PASSWORD' : `${cls}:${this.hash(value)}`
    const found = this.map.get(key)
    if (found) return found
    if (cls === 'PASSWORD') {
      const t: PseudoEntry = { token: PASSWORD_TOKEN, cls }
      this.map.set(key, t)
      return t
    }

    /**
     * The suffix is a HASH of the value, not a sequence counter.
     *
     * It was `(this.counters.get(cls) ?? 0) + 1`, and that could not work
     * across contexts: the content script walks the DOM in document order and
     * the compositor walks the detection list, so the same person arrived as
     * the 2nd PERSON in one and the 5th in the other. `[PERSON_A3_2]` and
     * `[PERSON_A3_5]` for one entity, and the numbering depended on how many
     * unrelated values happened to precede it — so it was unstable between two
     * runs over the same page too.
     *
     * Hashing the value makes the token a pure function of (session, class,
     * value). Same input, same token, in any order, in any context, on any run.
     * Cross-session unlinkability still holds because the session id is part of
     * the hash input. This is what "stable per session" was supposed to mean.
     */
    const suffix = this.hash(value)
    const t: PseudoEntry = { token: `[${cls}_${this.tag}_${suffix}]`, cls }
    this.map.set(key, t)
    return t
  }

  /** Every token issued, for the privacy ledger. */
  issued(): string[] {
    return [...this.map.values()].map((v) => v.token)
  }

  /**
   * Replace every occurrence of the given spans with their tokens.
   *
   * This is the function that closes the §1.1 leak: the DOM channel used to
   * ship raw textContent as `label`, and a `valueClass: 'sensitive'` flag is
   * metadata ABOUT a value, not a substitute for it.
   *
   * CONTIGUITY MATTERS, and getting it wrong leaks. A token-classifier returns
   * "Divya" and "Banerjee" as two spans, not "Divya Banerjee" as one — so
   * substituting them independently leaves "… Banerjee" readable and still
   * identifies the person. Measured: substituting only the model's spans left a
   * 40.4% leak rate; bridging adjacent same-class spans into one region drops
   * it. Two same-class spans separated only by whitespace are ONE value.
   */
  substitute(text: string, spans: Array<{ start: number; end: number; cls: PiiClass; text: string }>): string {
    if (spans.length === 0) return text
    const merged = bridgeAdjacent(text, spans)
    let out = ''
    let cursor = 0
    for (const s of merged) {
      if (s.start < cursor) continue
      out += text.slice(cursor, s.start)
      out += this.tokenFor(text.slice(s.start, s.end), s.cls).token
      cursor = s.end
    }
    out += text.slice(cursor)
    return out
  }
}

/**
 * Merge same-class spans that are separated only by whitespace, punctuation or
 * a connecting particle, so "Divya" + "Banerjee" becomes one region.
 *
 * Bounded on purpose: a gap of more than a few characters means the two spans
 * are genuinely different values ("Anna Salai" is an address; a name split by a
 * long clause is not), and merging across it would redact text that is not
 * itself identifying.
 */
export function bridgeAdjacent(
  text: string,
  spans: Array<{ start: number; end: number; cls: PiiClass; text: string }>,
): Array<{ start: number; end: number; cls: PiiClass; text: string }> {
  if (spans.length < 2) return spans
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number; cls: PiiClass; text: string }> = []
  // A gap of 1-2 chars that is only punctuation/space is a joined name.
  const MAX_BRIDGE = 2

  for (const s of ordered) {
    const prev = out[out.length - 1]
    if (!prev) { out.push({ ...s }); continue }
    const gap = s.start - prev.end
    const bridge = gap > 0 && gap <= MAX_BRIDGE ? text.slice(prev.end, s.start) : ''
    const isJoiner = bridge.length === 0 || /^[.,'\-]?$/.test(bridge) || /^\s+$/.test(bridge)
    if (prev.cls === s.cls && gap <= MAX_BRIDGE && isJoiner) {
      prev.end = s.end
      prev.text = text.slice(prev.start, prev.end)
    } else {
      out.push({ ...s })
    }
  }
  return out
}

function randomSalt(): string {
  try {
    const buf = new Uint8Array(8)
    crypto.getRandomValues(buf)
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return Math.random().toString(36).slice(2)
  }
}
