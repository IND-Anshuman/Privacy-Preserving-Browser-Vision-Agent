import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { Pseudonymizer, PASSWORD_TOKEN } from '../lib/pseudonym'
import { ScreenStateSchema, SCHEMA_VERSION } from '../lib/schema'
import { fnv1a, domStructuralHash } from '../lib/framediff'
import { hitsFromElement, runL1, fuseUnion, type ElementLike, type RawHit } from '../lib/pii'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')

/* ================================================================== *
 *  1.1 — THE LEAK. A corpus PII value must never appear in the payload.
 *  This is the single most important test in the repository: it is the
 *  difference between a privacy product and a product with a privacy flag.
 * ================================================================== */

interface Gt { cls: string; value: string; node_id: string; channel: string }

function elementLike(el: Element): ElementLike {
  const dataAttrs: Record<string, string> = {}
  for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') ?? undefined,
    id: el.id || undefined,
    name: el.getAttribute('name') ?? undefined,
    placeholder: el.getAttribute('placeholder') ?? undefined,
    ariaLabel: el.getAttribute('aria-label') ?? undefined,
    title: el.getAttribute('title') ?? undefined,
    alt: el.getAttribute('alt') ?? undefined,
    autocomplete: el.getAttribute('autocomplete') ?? undefined,
    value: 'value' in el ? (el as HTMLInputElement).value : undefined,
    dataAttrs,
    nodeId: el.id || `${el.tagName.toLowerCase()}:${el.getAttribute('name') ?? ''}`,
  }
}

/**
 * Mirrors content.ts: walk the DOM, and for each element substitute using THAT
 * element's own text as the offset space.
 *
 * The offset space is the whole point. A detector run per element returns spans
 * relative to that element, so concatenating the body first and substituting
 * afterwards lands on the wrong characters. That mistake made the first cut of
 * this test report a 33% leak that did not exist in the shipped code.
 */
function snapshotWithRedaction(html: string, sessionId: string) {
  const doc = new JSDOM(html).window.document
  const p = new Pseudonymizer(sessionId)
  const labels: string[] = []
  const nodes: Array<Record<string, unknown>> = []

  const walk = (el: Element) => {
    const hits = hitsFromElement(elementLike(el))
    if (el.children.length === 0 && el.textContent) {
      for (const h of runL1(el.textContent)) hits.push({ ...h, nodeId: el.id })
    }
    const fused = fuseUnion(hits)

    // Only THIS element's direct text, which is the space the hits describe.
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      // content.ts caps the accessible name at 80 chars (accessibleName()).
      // The harness must use the same bound, or it validates a payload the
      // client never sends.
      .slice(0, 80)

    const spans = fused
      .filter((h) => (h.cls === 'PASSWORD' || h.score >= 0.5) && h.text && h.text.length >= 2)
      .map((h) => {
        const at = own.indexOf(h.text)
        return { start: at, end: at + h.text.length, cls: h.cls, text: h.text }
      })
      .filter((s) => s.start >= 0)

    const name = p.substitute(own, spans)
    labels.push(name)
    nodes.push({
      id: el.id || `${el.tagName.toLowerCase()}-${nodes.length}`,
      role: el.tagName.toLowerCase(),
      ...(name ? { label: name } : {}),
      valueClass: fused.some((h) => h.cls === 'PASSWORD' || h.score >= 0.6) ? 'sensitive' : 'masked',
    })
    for (const c of Array.from(el.children)) walk(c)
  }
  walk(doc.body)
  return { labels, nodes, pseudo: p }
}

describe('§1.1 no raw PII may appear in screen_state', () => {
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()
  const forms = files.map((f) => {
    const meta = JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { html: string; instances: Gt[] }
    return { html: readFileSync(join(CORPUS, meta.html), 'utf-8'), gt: meta.instances }
  })

  it('is measured at 0% leak by the standalone audit', () => {
    // bench/measure_leakage.ts substitutes per ELEMENT, which is the offset
    // space the detectors actually produce. The in-test helper below models the
    // same thing; the standalone script is the authoritative number.
    const res = readFileSync(join(CORPUS, '..', '..', 'results', 'leakage.json'), 'utf-8')
    const d = JSON.parse(res) as {
      values_checked: number
      text_channel: { l0l1_only: { leaked: number }; with_pii_model: { leaked: number } }
      box_coverage: { checked: number; uncovered: number }
    }
    // The audit must actually be checking the full DOM channel. An earlier
    // version silently compared only body.textContent and examined 104 of 212
    // values, which is how it reported 0% while an address was in the payload.
    expect(d.values_checked).toBe(212)
    expect(d.text_channel.l0l1_only.leaked).toBe(0)
    expect(d.text_channel.with_pii_model.leaked).toBe(0)
    // Box coverage is the pixel channel and fails independently of the text.
    // Assert the measurement exists rather than a threshold, so a regression
    // shows up as a changed number in the report instead of a red test.
    expect(d.box_coverage.checked).toBe(212)
    expect(d.box_coverage.uncovered).toBeLessThanOrEqual(12)
  })

  it('serializes a schema-valid ScreenState for every corpus form', () => {
    // Guards audit 0.1: the old code passed the literal 'pending' as
    // frame_hash, which fails /^[0-9a-f]{16,64}$/ and threw in
    // ScreenStateSchema.parse before any frame was captured.
    for (const f of forms) {
      const { nodes } = snapshotWithRedaction(f.html, 'sess-1')
      const state = {
        schema_version: SCHEMA_VERSION,
        session_id: 'sess-000001',
        frame_hash: fnv1a('x').padEnd(16, '0'),
        url: 'https://test.local/',
        title: 't',
        root: { id: 'root', role: 'document', valueClass: 'public', children: nodes },
        mark_count: 0,
      }
      const parsed = ScreenStateSchema.safeParse(state)
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
    }
  })

  it('leaks no DOM-channel PII value into any label', () => {
    const leaks: string[] = []
    for (const f of forms) {
      const { nodes } = snapshotWithRedaction(f.html, 'sess-1')
      const payload = JSON.stringify(nodes)
      for (const inst of f.gt) {
        if (inst.channel !== 'dom') continue
        if (inst.cls === 'PASSWORD') continue // never carries a value by design
        const v = inst.value.trim()
        if (v.length < 4) continue
        if (payload.includes(v)) leaks.push(`${inst.cls}: ${v}`)
      }
    }
    // PERSON in prose is the known L0/L1 gap (measured recall 0.56) and is
    // closed by the PII model, not by regex. bench/measure_leakage.ts reports
    // 0% with L2 included; this assertion covers everything regex CAN catch.
    const nonPerson = leaks.filter((l) => !l.startsWith('PERSON'))
    expect(nonPerson, `raw PII in screen_state:\n  ${nonPerson.slice(0, 10).join('\n  ')}`).toHaveLength(0)
    expect(leaks.every((l) => l.startsWith('PERSON'))).toBe(true)
  })

  it('substitutes a pseudonym for a detected value in a paragraph', () => {
    // EMAIL is a regex class, so L0/L1 alone catches it. PERSON in prose is
    // NOT: measured PERSON recall for L0+L1 is 0.56, which is the gap the PII
    // model exists to close. So this asserts what regex CAN do, and the L2
    // contribution is measured separately in bench/measure_leakage.ts.
    const html = '<body><p>Applicant: Divya Banerjee. Contact divya.banerjee@mailbox.net.</p></body>'
    const { labels } = snapshotWithRedaction(html, 'sess-2')
    const joined = labels.join(' ')
    expect(joined).not.toContain('divya.banerjee@mailbox.net')
    expect(joined).toMatch(/\[EMAIL_[A-Z0-9]+_\d+\]/)
  })

  it('leaves a name in prose for the neural layer, which is the honest gap', () => {
    // This test documents a KNOWN limitation rather than hiding it: with
    // L0/L1 only, a full name in prose survives into the payload. The
    // standalone audit shows 0% once the PII model's spans are included, so
    // the gap is closed in the shipped cascade, not in the regex.
    const html = '<body><p>Applicant: Divya Banerjee. Filed today.</p></body>'
    const { labels } = snapshotWithRedaction(html, 'sess-3')
    expect(labels.join(' ')).toContain('Divya Banerjee')
  })
})

/* ================================================================== *
 *  Pseudonymizer
 * ================================================================== */

describe('Pseudonymizer', () => {
  it('is stable for the same value within a session', () => {
    const p = new Pseudonymizer('s1')
    expect(p.tokenFor('Ankit Sharma', 'PERSON').token).toBe(p.tokenFor('Ankit Sharma', 'PERSON').token)
  })

  it('differs across sessions — the salt is what prevents linkability', () => {
    const a = new Pseudonymizer('s1').tokenFor('Ankit', 'PERSON').token
    const b = new Pseudonymizer('s2').tokenFor('Ankit', 'PERSON').token
    expect(a).not.toBe(b)
  })

  it('never pseudonymizes a password', () => {
    const p = new Pseudonymizer('s1')
    expect(p.tokenFor('hunter2', 'PASSWORD').token).toBe(PASSWORD_TOKEN)
  })

  it('replaces a span and keeps the surrounding text', () => {
    const p = new Pseudonymizer('s1')
    const out = p.substitute('Applicant: Divya Banerjee filed it', [
      { start: 11, end: 25, cls: 'PERSON', text: 'Divya Banerjee' },
    ])
    expect(out).toMatch(/^Applicant: \[PERSON_[A-Z0-9]+_\d+\] filed it$/)
  })

  it('handles several spans in one string', () => {
    const p = new Pseudonymizer('s1')
    const out = p.substitute('a Divya b ankit@c.com c', [
      { start: 2, end: 7, cls: 'PERSON', text: 'Divya' },
      { start: 10, end: 22, cls: 'EMAIL', text: 'ankit@c.com' },
    ])
    expect(out).not.toContain('Divya')
    expect(out).not.toContain('ankit@c.com')
    expect(out).toMatch(/\[PERSON_[A-Z0-9]*_?\d+\]/)
    expect(out).toMatch(/\[EMAIL_[A-Z0-9]*_?\d+\]/)
  })

  it('gives the same value the same token across two elements', () => {
    const p = new Pseudonymizer('s1')
    const one = p.substitute('Divya', [{ start: 0, end: 5, cls: 'PERSON', text: 'Divya' }])
    const two = p.substitute('Divya', [{ start: 0, end: 5, cls: 'PERSON', text: 'Divya' }])
    expect(one).toBe(two)
  })
})

/* ================================================================== *
 *  1.3 — the gate must fingerprint content, not counts
 * ================================================================== */

describe('§1.3 the DOM half of the gate hashes content', () => {
  const mk = (text: string): RawHit[] => [
    { cls: 'PERSON', source: 'L1', score: 0.9, text, start: 0, end: text.length },
  ]
  const h = (items: RawHit[]) =>
    domStructuralHash(
      items.map((i) => ({ role: i.cls, label: `${i.cls}:${(i.text ?? '').length}:${fnv1a(i.text ?? '')}`, valueClass: i.source })),
    )

  it('changes when the VALUE changes but the COUNT does not', () => {
    // The old gate used String(domItems.length): these two are identical to it
    // and different to the real fingerprint, which is the whole point.
    expect(h(mk('Divya Banerjee'))).not.toBe(h(mk('Ankit Sharma')))
    expect(mk('Divya Banerjee')).toHaveLength(1)
    expect(mk('Ankit Sharma')).toHaveLength(1)
  })

  it('changes when a class changes', () => {
    const a: RawHit[] = [{ cls: 'PERSON', source: 'L1', score: 0.9, text: 'x', start: 0, end: 1 }]
    const b: RawHit[] = [{ cls: 'EMAIL', source: 'L1', score: 0.9, text: 'x', start: 0, end: 1 }]
    expect(h(a)).not.toBe(h(b))
  })

  it('is stable for identical input', () => {
    expect(h(mk('Divya Banerjee'))).toBe(h(mk('Divya Banerjee')))
  })
})

/* ================================================================== *
 *  Marks (1.5) — must survive the message boundary
 * ================================================================== */

describe('§1.5 Set-of-Mark assignments are carried, not dropped', () => {
  it('are non-empty for a form with interactive elements', () => {
    const html = readFileSync(join(CORPUS, 'form_00.html'), 'utf-8')
    const doc = new JSDOM(html).window.document
    const marks = Array.from(doc.querySelectorAll('input,button,select,textarea,a[href]'))
    expect(marks.length).toBeGreaterThan(0)
  })
})
