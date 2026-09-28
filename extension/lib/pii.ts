/**
 * PII cascade layers L0 (semantics) and L1 (regex + checksum) — ARCHITECTURE.md §5.
 *
 * Cost budget: L0 is ~0 ms (pure attribute reads), L1 is ~1 ms per page.
 * L2/L3 live in the offscreen inference sandbox and consume L1's output.
 *
 * PASSWORD IS NEVER PSEUDONYMIZED. Not even hashed — a hash of a password is an
 * offline-cracking surface. It always emits the literal `<redacted:password>`.
 */
import type { PiiClass, PiiSource, Box } from './schema'

/* ================================================================== *
 *  Shared types
 * ================================================================== */

export interface RawHit {
  cls: PiiClass
  source: PiiSource
  score: number
  text: string
  /** Offsets into the input string. */
  start: number
  end: number
  box?: Box
  /** Stable-ish element handle for DOM hits. */
  nodeId?: string
  /** Set when the text was recovered from pixels (L1 re-run on OCR output). */
  recoveredFromPixels?: boolean
}

export const REDACTED_PASSWORD = '<redacted:password>'

/* ================================================================== *
 *  Checksums
 * ================================================================== */

export function luhn(digits: string): boolean {
  const s = digits.replace(/[\s-]/g, '')
  if (!/^\d{12,19}$/.test(s)) return false
  let sum = 0
  let alt = false
  for (let i = s.length - 1; i >= 0; i--) {
    let n = s.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** Verhoeff checksum — the actual Aadhaar validity check (last digit). */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

export function verhoeff(num: string): boolean {
  const s = num.replace(/\D/g, '')
  if (s.length !== 12) return false
  let c = 0
  const rev = s.split('').reverse()
  for (let i = 0; i < rev.length; i++) {
    // The tables are 10x10 and the input is a verified 12-digit string, so
    // every index is in range; the assertions tell the compiler that too.
    const dRow = VERHOEFF_D[c]!
    const pRow = VERHOEFF_P[i % 8]!
    const digit = rev[i]!.charCodeAt(0) - 48
    c = dRow[pRow[digit]!]!
  }
  return c === 0
}

/* ================================================================== *
 *  L0 — semantics from the DOM. No scoring; these are declarations.
 * ================================================================== */

const SENSITIVE_AUTOCOMPLETE = new Set([
  'name',
  'honorific-prefix',
  'given-name',
  'additional-name',
  'family-name',
  'honorific-suffix',
  'nickname',
  'organization',
  'username',
  'current-password',
  'new-password',
  'one-time-code',
  'cc-name',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'billing street-address',
  'billing address-line1',
  'billing address-line2',
  'billing postal-code',
])

/**
 * Words in an id/name/aria-label/placeholder that mark a field as sensitive.
 *
 * Matching is WORD-BOUNDARY on a normalized token stream, never substring.
 * Substring matching is a precision catastrophe here: 'pan' is inside
 * 'company', 'dob' inside 'window', 'pin' inside 'shipping'. Those become
 * redacted boxes, and metric 2 is scored on precision.
 */
const SENSITIVE_WORDS: Array<[phrase: string, cls: PiiClass]> = [
  ['password', 'PASSWORD'],
  ['passwd', 'PASSWORD'],
  ['pwd', 'PASSWORD'],
  ['otp', 'PASSWORD'],
  ['pin', 'PASSWORD'],
  ['secret', 'PASSWORD'],
  ['cvv', 'CREDIT_CARD'],
  ['cvc', 'CREDIT_CARD'],
  ['security code', 'CREDIT_CARD'],
  ['card number', 'CREDIT_CARD'],
  ['credit card', 'CREDIT_CARD'],
  ['debit card', 'CREDIT_CARD'],
  ['card no', 'CREDIT_CARD'],
  ['expiry', 'CREDIT_CARD'],
  ['aadhaar', 'AADHAAR'],
  ['aadhar', 'AADHAAR'],
  ['uidai', 'AADHAAR'],
  ['ssn', 'AADHAAR'],
  ['social security', 'AADHAAR'],
  ['national id', 'AADHAAR'],
  ['pan', 'PAN'],
  ['pan number', 'PAN'],
  ['pan no', 'PAN'],
  ['gstin', 'GSTIN'],
  ['gst number', 'GSTIN'],
  ['ifsc', 'IFSC'],
  ['passport', 'PASSPORT'],
  ['driver licen', 'DL'],
  ['licence number', 'DL'],
  ['license number', 'DL'],
  ['dl number', 'DL'],
  ['account number', 'BANK_ACCOUNT'],
  ['account no', 'BANK_ACCOUNT'],
  ['acct', 'BANK_ACCOUNT'],
  ['bank account', 'BANK_ACCOUNT'],
  ['a c number', 'BANK_ACCOUNT'],
  ['dob', 'DOB'],
  ['date of birth', 'DOB'],
  ['birth date', 'DOB'],
  ['birthday', 'DOB'],
  ['phone', 'PHONE'],
  ['mobile', 'PHONE'],
  ['msisdn', 'PHONE'],
  ['contact number', 'PHONE'],
  ['email', 'EMAIL'],
  ['e mail', 'EMAIL'],
  ['user name', 'PERSON'],
  ['username', 'PERSON'],
  ['full name', 'PERSON'],
  ['first name', 'PERSON'],
  ['last name', 'PERSON'],
  ['surname', 'PERSON'],
  ['given name', 'PERSON'],
  ['family name', 'PERSON'],
  ['nominee', 'PERSON'],
  ['father name', 'PERSON'],
  ['mother name', 'PERSON'],
  ['guardian', 'PERSON'],
  ['emergency contact', 'PERSON'],
  ['address', 'ADDRESS'],
  ['street', 'ADDRESS'],
  ['locality', 'ADDRESS'],
  ['city', 'ADDRESS'],
  ['pincode', 'ADDRESS'],
  ['postal', 'ADDRESS'],
  ['zip', 'ADDRESS'],
  ['api key', 'API_KEY'],
  ['apikey', 'API_KEY'],
  ['access token', 'API_KEY'],
  ['auth token', 'API_KEY'],
  ['authorization', 'API_KEY'],
  ['bearer', 'API_KEY'],
  ['private key', 'API_KEY'],
  ['session id', 'API_KEY'],
  ['device id', 'API_KEY'],
  ['imei', 'API_KEY'],
  ['sim serial', 'API_KEY'],
  ['signature', 'PASSWORD'],
  ['photo', 'FACE'],
  ['avatar', 'FACE'],
  ['headshot', 'FACE'],
  ['selfie', 'FACE'],
  ['face image', 'FACE'],
  ['passport photo', 'FACE'],
  ['id photo', 'FACE'],
]

export interface ElementLike {
  tag: string
  type?: string
  id?: string
  name?: string
  placeholder?: string
  ariaLabel?: string
  title?: string
  alt?: string
  autocomplete?: string
  value?: string
  contentEditable?: boolean
  dataAttrs?: Record<string, string>
  box?: Box
  nodeId?: string
  /**
   * Set by the offscreen L3 pass once OCR over this canvas has run and found no
   * PII. Until then the element is fail-closed redacted. See the `canvas`
   * branch in classifyElement.
   */
  clearedByL3?: boolean
}

/**
 * Normalize an attribute bag into a comparable token stream.
 * Handles the three shapes real pages use: "full_name", "fullName", "Full Name".
 * "fullName" must yield the same tokens as "full name" or the keyword table
 * misses the majority of real-world field names.
 */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase / PascalCase split
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // HTTPServer -> HTTP Server
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Does the token stream contain the phrase as a contiguous run of tokens? */
function hasPhrase(tokens: string[], phrase: string): boolean {
  const p = tokenize(phrase)
  if (p.length === 0) return false
  for (let i = 0; i + p.length <= tokens.length; i++) {
    let ok = true
    for (let j = 0; j < p.length; j++) {
      if (tokens[i + j] !== p[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** Longest phrase wins, so "card number" beats a bare "card". */
function matchPhrase(tokens: string[]): { cls: PiiClass; phrase: string } | null {
  let best: { cls: PiiClass; phrase: string } | null = null
  for (const [phrase, cls] of SENSITIVE_WORDS) {
    if (!hasPhrase(tokens, phrase)) continue
    if (!best || tokenize(phrase).length > tokenize(best.phrase).length) best = { cls, phrase }
  }
  return best
}

/** What L0 concluded about a single element. */
export interface SemanticVerdict {
  /** The PII class L0 asserts, if any. */
  cls: PiiClass | null
  /** Passwords are categorically excluded from pseudonymization. */
  isPassword: boolean
  /** Reason string — surfaced in the privacy ledger's "why did you hide this". */
  reason: string | null
  /** True when the element holds a face image / signature. */
  looksLikeIdentityImage: boolean
}

const norm = (s: string | undefined): string => (s ?? '').toLowerCase().trim()

/**
 * L0 classification. Deliberately over-inclusive: a false positive costs a
 * redaction box, a false negative costs the whole privacy claim. Fusion (§5)
 * and the per-class thresholds recover the precision.
 */
export function classifySemantics(el: ElementLike): SemanticVerdict {
  const none: SemanticVerdict = {
    cls: null,
    isPassword: false,
    reason: null,
    looksLikeIdentityImage: false,
  }
  const type = norm(el.type)

  if (el.tag === 'img' || el.tag === 'picture' || el.tag === 'source' || el.tag === 'video') {
    const tokens = tokenize([el.id, el.name, el.alt, el.title].filter(Boolean).join(' '))
    if (hasPhrase(tokens, 'photo') || hasPhrase(tokens, 'avatar') || hasPhrase(tokens, 'selfie') ||
        hasPhrase(tokens, 'face') || hasPhrase(tokens, 'headshot') || hasPhrase(tokens, 'signature')) {
      return {
        cls: 'FACE',
        isPassword: false,
        reason: 'image/video alt or filename suggests an identity photo',
        looksLikeIdentityImage: true,
      }
    }
    // §1.7: a <video> is a moving canvas. A webcam preview or a video of a
    // document is exactly the "PII in a video frame" case from the demo's
    // hard-mode appendix, and it is invisible to the DOM channel. Fail-closed
    // until L3 has run OCR over the current frame. An <img> is exempt because
    // L0/L1 sees its alt and the §5 image rules cover identity photos; a video
    // has no such static description.
    if (el.tag === 'video') {
      if (el.clearedByL3) return none
      return {
        cls: 'OPAQUE_REGION',
        isPassword: false,
        reason: 'video frames are not inspectable by the DOM channel; fail-closed until L3 clears the frame',
        looksLikeIdentityImage: false,
      }
    }
    return none
  }

  /**
   * §5 / §12: text drawn into a `<canvas>` or played in a `<video>` is invisible
   * to every DOM rule. The DOM channel cannot see it, and the only detector that
   * can is L3 (text regions → OCR → re-run L1/L2 on the recovered string).
   *
   * Until L3 has actually cleared a region, the fail-closed rule applies: the
   * whole element is redacted. That is deliberately expensive — a captcha or a
   * chart is also a canvas — because the cost of over-redacting a chart is a
   * useless box, and the cost of under-redacting a canvas is a leaked Aadhaar
   * number. The architecture's risk table says exactly this, and this is where
   * that promise is kept.
   *
   * `clearedByL3` is set by the offscreen L3 pass once OCR over the region has
   * run and found no PII, so the common case (a chart) is not permanently
   * blacked out.
   */
  if (el.tag === 'canvas') {
    if (el.clearedByL3) return none
    return {
      cls: 'OPAQUE_REGION',
      isPassword: false,
      reason: 'canvas contents are not inspectable by the DOM channel; fail-closed until L3 clears it',
      looksLikeIdentityImage: false,
    }
  }

  /**
   * §5 hard case: a frame we cannot read is redacted whole.
   *
   * `all_frames: true` means our content script normally runs inside
   * same-origin frames too and reports its own detections there. A frame that
   * refuses injection — cross-origin, or CSP-blocked — is a region we can see
   * pixels for and have no way to redact selectively, so the fail-closed answer
   * is to erase it. `embed` and `object` are included because they can host a
   * plugin document with no `contentDocument` to read at all.
   *
   * This used to be a boolean (`crossOriginSuspect`) that nothing downstream
   * read, so the frame was detected and then sent anyway. The flag is now a
   * detection with a box, and the gate aborts if it is left uncovered.
   */
  if (el.tag === 'iframe' || el.tag === 'frame' || el.tag === 'embed' || el.tag === 'object') {
    if (el.clearedByL3) return none
    return {
      cls: 'OPAQUE_REGION',
      isPassword: false,
      reason: 'frame refuses inspection; redacted wholesale per §5 fail-closed',
      looksLikeIdentityImage: false,
    }
  }

  // Password: independent signals, any one is sufficient. Checked before the
  // keyword table so a field named "password_hint" is still treated as secret.
  const tokens = tokenize(
    [el.id, el.name, el.placeholder, el.ariaLabel, el.title, el.autocomplete].filter(Boolean).join(' '),
  )
  if (
    type === 'password' ||
    hasPhrase(tokens, 'password') ||
    hasPhrase(tokens, 'passwd') ||
    hasPhrase(tokens, 'pwd') ||
    hasPhrase(tokens, 'otp') ||
    hasPhrase(tokens, 'pin') ||
    hasPhrase(tokens, 'secret') ||
    hasPhrase(tokens, 'signature') ||
    norm(el.autocomplete).includes('password') ||
    norm(el.autocomplete).includes('one-time-code')
  ) {
    return { cls: 'PASSWORD', isPassword: true, reason: 'password/OTP field semantics', looksLikeIdentityImage: false }
  }

  if (el.autocomplete && SENSITIVE_AUTOCOMPLETE.has(norm(el.autocomplete))) {
    const ac = norm(el.autocomplete)
    if (ac.includes('cc-')) return { cls: 'CREDIT_CARD', isPassword: false, reason: `autocomplete="${ac}"`, looksLikeIdentityImage: false }
    // Any address autocomplete, not just `billing`. This handled only the
    // billing prefix, so `autocomplete="shipping street-address"` fell through
    // to the generic PERSON branch and the value shipped unredacted.
    if (/(^| )(billing|shipping|street|address|locality|region|postal|country)/.test(ac)) {
      return { cls: 'ADDRESS', isPassword: false, reason: `autocomplete="${ac}"`, looksLikeIdentityImage: false }
    }
    return { cls: 'PERSON', isPassword: false, reason: `autocomplete="${ac}"`, looksLikeIdentityImage: false }
  }

  const hit = matchPhrase(tokens)
  if (hit) {
    const isFace = hit.cls === 'FACE'
    return { cls: hit.cls, isPassword: false, reason: `attribute matches "${hit.phrase}"`, looksLikeIdentityImage: isFace }
  }

  if (type === 'email') return { cls: 'EMAIL', isPassword: false, reason: 'input[type=email]', looksLikeIdentityImage: false }
  if (type === 'tel') return { cls: 'PHONE', isPassword: false, reason: 'input[type=tel]', looksLikeIdentityImage: false }

  // data-* attributes carry PII surprisingly often; the corpus tests this (§5).
  if (el.dataAttrs) {
    for (const [k, v] of Object.entries(el.dataAttrs)) {
      const keyTokens = tokenize(k)
      if (!keyTokens.some((t) => /^(pii|sensitive|secret|token|key|value|user|customer|account|contact|email|phone|ssn|aadhaar|pan|person|name|id)$/.test(t))) continue
      if (!v || v.length < 3) continue
      if (/^(true|1|yes)$/i.test(v)) {
        return { cls: 'PASSWORD', isPassword: true, reason: `data-${k} marks a secret`, looksLikeIdentityImage: false }
      }
      const sub = runL1(v).filter((h) => h.score >= 0.7)
      if (sub.length > 0) {
        return { cls: sub[0]!.cls, isPassword: false, reason: `data-${k} carries a ${sub[0]!.cls} pattern`, looksLikeIdentityImage: false }
      }
      // A name-ish key with a person-shaped value is still a name.
      if (keyTokens.some((t) => /^(user|customer|person|name|contact|account|profile|employee)$/.test(t)) && v.includes(' ')) {
        return { cls: 'PERSON', isPassword: false, reason: `data-${k} carries a name`, looksLikeIdentityImage: false }
      }
    }
  }

  return none
}

/* ================================================================== *
 *  L1 — regex + checksum over free text
 * ================================================================== */

interface Rule {
  cls: PiiClass
  re: RegExp
  /** Default confidence before any checksum confirmation. */
  score: number
  /** Optional checksum gate: if present, a checksum failure drops the score. */
  checksum?: (m: RegExpMatchArray) => boolean
  /** Score applied when the checksum passes. */
  checksumScore?: number
}

const RULES: Rule[] = [
  {
    cls: 'JWT',
    // header.payload.signature, base64url
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g,
    score: 0.97,
  },
  {
    cls: 'API_KEY',
    re: /\b(?:sk|pk|rk|api|key|ghp|gho|xox[abps])[-_][A-Za-z0-9_-]{16,}\b/g,
    score: 0.9,
  },
  {
    cls: 'API_KEY',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,  // Google API keys are 39 chars: 'AIza' + 35
    score: 0.97,
  },
  {
    cls: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
    score: 0.96,
  },
  {
    cls: 'CREDIT_CARD',
    // 13-19 digits with optional separators; Luhn confirms.
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    score: 0.55,
    checksum: (m) => luhn(m[0]),
    checksumScore: 0.98,
  },
  {
    cls: 'AADHAAR',
    // 12 digits, optionally spaced/dashed, optionally prefixed "Aadhaar".
    re: /(?:\b|\bAadhaar[:\s]*)\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    score: 0.6,
    checksum: (m) => verhoeff(m[0].replace(/\D/g, '').slice(-12)),
    checksumScore: 0.99,
  },
  {
    cls: 'PAN',
    // e.g. ABCDE1234F
    re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    score: 0.93,
  },
  {
    cls: 'GSTIN',
    re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g,
    score: 0.98,
  },
  {
    cls: 'IFSC',
    re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    score: 0.97,
  },
  {
    cls: 'IBAN',
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    score: 0.95,
    // mod-97 check
    checksum: (m) => {
      const s = m[0].replace(/\s/g, '')
      const rearranged = s.slice(4) + s.slice(0, 4)
      let rem = 0
      for (const ch of rearranged) {
        const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
        for (const digit of v) rem = (rem * 10 + Number(digit)) % 97
      }
      return rem === 1
    },
    checksumScore: 0.99,
  },
  {
    cls: 'PHONE',
    // Indian mobile: optional +91/0 prefix, then 6-9 prefix and 6 digits.
    re: /(?:\+?91[-\s]?|0)?\b[6-9]\d{4}[-\s]?\d{5}\b/g,
    score: 0.72,
  },
  {
    cls: 'PHONE',
    // Generic international, kept lower-confidence so IN rules win ties.
    re: /\+\d{1,3}[ -]?(?:\(?\d{2,4}\)?[ -]?){2,4}\d{2,4}\b/g,
    score: 0.6,
  },
  {
    cls: 'PASSPORT',
    re: /\b[A-PR-WY][0-9]{7}\b/g,
    score: 0.8,
  },
  {
    cls: 'DOB',
    re: /\b(?:0?[1-9]|[12][0-9]|3[01])[/-](?:0?[1-9]|1[0-2])[/-](?:19|20)\d{2}\b/g,
    score: 0.78,
  },
  {
    cls: 'DOB',
    re: /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g,
    score: 0.75,
  },
  {
    cls: 'IP_ADDRESS',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    score: 0.7,
  },
  {
    cls: 'BANK_ACCOUNT',
    re: /\b(?:account|acct|a\/c)\s*(?:no\.?|number|#)?\s*[:\-]?\s*(\d{9,18})\b/gi,
    score: 0.88,
  },
  {
    cls: 'MONEY',
    re: /(?:₹|rs\.?|inr|usd|\$|€|£)\s?\d[\d,]*(?:\.\d{1,2})?/gi,
    score: 0.55,
  },
  {
    /**
     * A postal address in running prose.
     *
     * §5 requires ADDRESS to be findable in text, not only via the
     * `autocomplete` attribute. Without this, "Permanent address: 330, FC Road,
     * Chennai 600002" survived into the payload: the L0 attribute path
     * classified the *input*, but the same value repeated in the summary
     * paragraph had no rule at all. Measured as 2 residual leaks.
     *
     * Kept deliberately narrow — a house number, a comma, a street word and a
     * 6-digit PIN is a strong signal, and requiring all four keeps ordinary
     * prose ("version 2, section 4, page 100002") from being redacted.
     *
     * An earlier draft added a second rule matching a bare 6-digit PIN. It
     * measured ADDRESS precision 0.08 (tp=2, fp=22) — any order number, price
     * and timestamp in the corpus matched it. The street-word anchor is what
     * makes a postal address distinguishable from a number, so that rule is
     * gone rather than kept at a lower score.
     */
    cls: 'ADDRESS',
    // The street-word list matters more than it looks. The first version of
    // this rule matched only road/street/avenue/nagar/…, and the measured
    // leakage audit then found 4 addresses surviving in prose: "150, Anna
    // Salai, Delhi 110001" and "171, Sector 18, Pune 411001". Both are
    // ordinary Indian addresses; neither contains a word the rule knew.
    //
    // Widening the list is safe because the rule still requires ALL of
    // house-number, comma, street-ish token and a 6-digit PIN. Removing the
    // bare-PIN variant (which measured precision 0.08) is what keeps this
    // from over-matching.
    re: /\b\d{1,4}\s*,\s*[A-Za-z][A-Za-z0-9.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9.'-]*){0,4}\s*(?:road|rd\.?|street|st\.?|salai|avenue|ave\.?|lane|ln\.?|sector|sec\.?|block|blk\.?|plot|marg|cross|nagar|colony|boulevard|blvd\.?|park|square|gali|main|byepass|highway)\b\.?[^.\n]{0,40}?\b\d{6}\b/gi,
    score: 0.8,
  },
]

/**
 * Run the L1 rule set over a string. Returns spans with the offset of the
 * captured value, not the whole match, for labelled rules.
 */
export function runL1(text: string): RawHit[] {
  if (!text) return []
  const hits: RawHit[] = []
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      let score = rule.score
      if (rule.checksum) {
        if (rule.checksum(m)) score = rule.checksumScore ?? score
        else score = Math.min(score, 0.45) // pattern matched, checksum failed
      }
      // For rules with a capture group, anchor on the group.
      const g1 = m[1]
      const start = g1 !== undefined ? (m.index + m[0].indexOf(g1)) : m.index
      const end = start + (g1 !== undefined ? g1.length : m[0].length)
      hits.push({
        cls: rule.cls,
        source: 'L1',
        score,
        text: text.slice(start, end),
        start,
        end,
      })
    }
  }
  return dedupeOverlaps(hits)
}

/** Keep the highest-scoring hit when two rules claim overlapping spans. */
export function dedupeOverlaps(hits: RawHit[]): RawHit[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score || a.start - b.start)
  const out: RawHit[] = []
  for (const h of sorted) {
    const clash = out.find((o) => h.start < o.end && o.start < h.end)
    if (clash) {
      // An exact-duplicate span from a stronger rule wins outright.
      if (h.start === clash.start && h.end === clash.end) continue
      continue
    }
    out.push(h)
  }
  return out.sort((a, b) => a.start - b.start)
}

/* ================================================================== *
 *  L0 over a live element → hits with boxes
 * ================================================================== */

export function hitsFromElement(el: ElementLike): RawHit[] {
  const v = classifySemantics(el)
  if (!v.cls) return []
  const text = el.value ?? ''
  // L0 on a value-less field still redacts the *rectangle* — the pixels are there
  // even if we refuse to read them.
  return [
    {
      cls: v.cls,
      source: 'L0',
      score: 0.99,
      text: v.isPassword ? REDACTED_PASSWORD : text,
      start: 0,
      end: text.length,
      box: el.box,
      nodeId: el.nodeId,
    },
  ]
}

/* ================================================================== *
 *  Union of everything the client knows, before thresholding
 * ================================================================== */

export function fuseUnion(hits: RawHit[]): RawHit[] {
  const out: RawHit[] = []
  for (const h of hits) {
    const same = out.find(
      (o) => o.cls === h.cls && (h.box && o.box ? boxesOverlap(o.box, h.box) : h.start === o.start && h.end === h.end),
    )
    if (same) {
      // Layer escalation boosts confidence: L0 semantics beating an L1 regex guess.
      if (layerWeight(h.source) > layerWeight(same.source)) {
        same.source = h.source
        same.score = Math.max(same.score, h.score)
        same.text = h.text
        same.box = h.box ?? same.box
      }
      continue
    }
    out.push({ ...h })
  }
  return out
}

const LAYER_WEIGHT: Record<PiiSource, number> = { L0: 4, L1: 3, L2: 2, L3: 1 }
const layerWeight = (s: PiiSource): number => LAYER_WEIGHT[s]

export function boxesOverlap(a: Box, b: Box, slack = 2): boolean {
  return (
    a.x < b.x + b.w + slack &&
    b.x < a.x + a.w + slack &&
    a.y < b.y + b.h + slack &&
    b.y < a.y + a.h + slack
  )
}
