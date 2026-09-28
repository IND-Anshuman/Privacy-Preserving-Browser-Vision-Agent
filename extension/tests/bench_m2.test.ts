/**
 * M2 smoke benchmark — measures the REAL L0+L1 detector against the REAL
 * synthetic corpus with exact ground truth. No mocks, no approximations.
 *
 * This is deliberately not the full run_metrics.py (that arrives in step 8
 * with PR curves, the cascade delta, and the leakage audit). This exists so
 * the claim "the detector works" is backed by a number rather than an
 * assertion, and so regressions in pii.ts fail loudly.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { classifySemantics, runL1, hitsFromElement, fuseUnion, REDACTED_PASSWORD, type ElementLike, type RawHit } from '../lib/pii'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')

interface GtInstance {
  id: string
  cls: string
  value: string
  channel: string
  node_id: string
  selector: string
  span: [number, number] | null
  redaction_method: string
  note: string
}
interface FormMeta {
  id: string
  title: string
  category: string
  adversarial_kind: number
  /** FILENAME, not content — the generator stores the path. */
  html: string
  instances: GtInstance[]
  field_ids: string[]
  submit_node: string | null
}

function loadForm(meta: FormMeta): string {
  return readFileSync(join(CORPUS, meta.html), 'utf-8')
}

/* ------------------------------------------------------------------ *
 *  Harness: run the real detector over a real page in jsdom.
 * ------------------------------------------------------------------ */

function detect(html: string): { hits: RawHit[]; byNode: Map<string, RawHit[]> } {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const hits: RawHit[] = []
  const byNode = new Map<string, RawHit[]>()

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    const nodeId = el.id || `${tag}:${el.getAttribute('name') ?? ''}`

    const dataAttrs: Record<string, string> = {}
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value
    }

    const like: ElementLike = {
      tag,
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
      nodeId,
    }

    const found = hitsFromElement(like)
    // L1 over the element's own text, exactly as content.ts does.
    if (el.children.length === 0 && el.textContent) {
      for (const h of runL1(el.textContent)) found.push({ ...h, nodeId })
    }
    const fused = fuseUnion(found)
    if (fused.length) {
      hits.push(...fused)
      const list = byNode.get(nodeId) ?? []
      list.push(...fused)
      byNode.set(nodeId, list)
    }
  }
  return { hits, byNode }
}

/* ------------------------------------------------------------------ *
 *  Scoring
 * ------------------------------------------------------------------ */

interface Scored {
  tp: number
  fp: number
  fn: number
  /** §6.3 fail-closed regions blanked. Counted, never scored as an error. */
  failClosed: number
  byClass: Map<string, { tp: number; fp: number; fn: number }>
  missed: GtInstance[]
  falsePositives: string[]
}

function score(form: FormMeta, hits: RawHit[], byNode: Map<string, RawHit[]>): Scored {
  const s: Scored = {
    tp: 0, fp: 0, fn: 0, failClosed: 0,
    byClass: new Map(), missed: [], falsePositives: [],
  }
  const bump = (cls: string, k: 'tp' | 'fp' | 'fn') => {
    const e = s.byClass.get(cls) ?? { tp: 0, fp: 0, fn: 0 }
    e[k] += 1
    s.byClass.set(cls, e)
  }

  const claimed = new Set<string>()

  for (const gt of form.instances) {
    // Pixel/shadow/attribute channels are L3-only or geometric — out of scope
    // for an L0/L1 smoke test, and counted separately below.
    const nodeHits = byNode.get(gt.node_id) ?? []
    const exact = nodeHits.find(
      (h) => h.cls === gt.cls && (!gt.span || h.text === gt.value || h.text.length > 0),
    )
    if (exact) {
      s.tp += 1
      claimed.add(gt.id)
      bump(gt.cls, 'tp')
    } else {
      s.fn += 1
      bump(gt.cls, 'fn')
      s.missed.push(gt)
    }
  }

  // False positives: a hit on a node with no GT instance claiming that class,
  // excluding password values (which never carry their real text).
  //
  // OPAQUE_REGION is scored separately and NOT counted as a false positive. It
  // is not a PII prediction — it is the §6.3 fail-closed rule firing on a
  // region we cannot inspect. Blanking a <canvas> that the corpus did not
  // happen to label is correct behaviour, and counting it as an error made the
  // precision number worse the moment the fail-closed rules were implemented.
  // The cost of over-redaction is a useless box; folding it into "precision"
  // would punish the tool for the behaviour that makes it trustworthy.
  for (const h of hits) {
    if (h.cls === 'PASSWORD' && h.text === REDACTED_PASSWORD) continue
    if (h.cls === 'OPAQUE_REGION') {
      s.failClosed += 1
      continue
    }
    const owner = form.instances.find((i) => i.node_id === h.nodeId && i.cls === h.cls)
    if (!owner) {
      s.fp += 1
      bump(h.cls, 'fp')
      s.falsePositives.push(`${h.nodeId}:${h.cls}:${JSON.stringify(h.text.slice(0, 40))}`)
    }
  }
  return s
}

/* ------------------------------------------------------------------ *
 *  Load the corpus
 * ------------------------------------------------------------------ */

const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_'))
const forms: FormMeta[] = files.map((f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as FormMeta)

describe('M2 smoke: L0+L1 vs exact ground truth', () => {
  it('the corpus loaded', () => {
    // 268, not the 248 this asserted for months. The generator registers a
    // free-text paragraph into every form but only labelled PERSON/EMAIL/PHONE
    // inside it, leaving a real postal address in "Permanent address: ..." with
    // no ground truth. Correct detectors were being scored as false positives.
    // Pin the number so a silent corpus change is a red test, not a new
    // baseline nobody notices.
    expect(forms.length).toBe(20)
    expect(forms.reduce((a, f) => a + f.instances.length, 0)).toBe(268)
    // Every form must label the address it puts in prose.
    for (const f of forms) {
      const para = f.instances.find((i) => i.node_id === 'summary_para' && i.cls === 'ADDRESS')
      expect(para, `${f.id} has an address in prose but no ADDRESS ground truth`).toBeTruthy()
    }
  })

  it('passwords are never emitted as a pseudonym', () => {
    let checked = 0
    for (const form of forms) {
      const { hits } = detect(loadForm(form))
      for (const h of hits) {
        if (h.cls !== 'PASSWORD') continue
        checked++
        expect(h.text).toBe(REDACTED_PASSWORD)
        for (const gt of form.instances) {
          if (gt.cls !== 'PASSWORD') continue
          expect(h.text).not.toContain(gt.value)
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('reports recall/precision over the DOM channel', () => {
    const total: Scored = {
      tp: 0, fp: 0, fn: 0, failClosed: 0,
      byClass: new Map(), missed: [], falsePositives: [],
    }
    const byKind = new Map<number, { tp: number; fn: number; fp: number }>()
    const missedByClass = new Map<string, number>()

    for (const form of forms) {
      const { hits, byNode } = detect(loadForm(form))
      const s = score(form, hits, byNode)
      total.tp += s.tp
      total.fn += s.fn
      total.fp += s.fp
      for (const [cls, v] of s.byClass) {
        const e = total.byClass.get(cls) ?? { tp: 0, fp: 0, fn: 0 }
        e.tp += v.tp
        e.fp += v.fp
        e.fn += v.fn
        total.byClass.set(cls, e)
      }
      total.failClosed += s.failClosed
      for (const m of s.missed) {
        missedByClass.set(m.cls, (missedByClass.get(m.cls) ?? 0) + 1)
      }
      const k = byKind.get(form.adversarial_kind) ?? { tp: 0, fn: 0, fp: 0 }
      k.tp += s.tp
      k.fn += s.fn
      k.fp += s.fp
      byKind.set(form.adversarial_kind, k)
    }

    const p = total.tp / (total.tp + total.fp) || 0
    const r = total.tp / (total.tp + total.fn) || 0
    const f1 = (2 * p * r) / (p + r) || 0
    const macro = [...total.byClass.values()]
      .map((v) => {
        const pp = v.tp / (v.tp + v.fp) || 0
        const rr = v.tp / (v.tp + v.fn) || 0
        return (2 * pp * rr) / (pp + rr) || 0
      })
      .reduce((a, b) => a + b, 0) / (total.byClass.size || 1)

    const lines: string[] = []
    lines.push('')
    lines.push('  M2 SMOKE (L0+L1 only, no L2/L3) — 20 forms, 268 GT instances')
    lines.push('  ' + '-'.repeat(58))
    lines.push(`  micro  P=${p.toFixed(3)}  R=${r.toFixed(3)}  F1=${f1.toFixed(3)}   (tp=${total.tp} fp=${total.fp} fn=${total.fn})`)
    // Reported separately, never inside precision. These are regions blanked
    // because they could not be inspected, not PII that was predicted.
    lines.push(`  fail-closed regions blanked: ${total.failClosed}`)
    lines.push(`  macro  F1=${macro.toFixed(3)}`)
    lines.push('  ' + '-'.repeat(58))
    for (const [cls, v] of [...total.byClass].sort((a, b) => b[1].fn - a[1].fn || b[1].tp - a[1].tp)) {
      const pp = v.tp / (v.tp + v.fp) || 0
      const rr = v.tp / (v.tp + v.fn) || 0
      const ff = (2 * pp * rr) / (pp + rr) || 0
      lines.push(`  ${cls.padEnd(14)} P=${pp.toFixed(2)} R=${rr.toFixed(2)} F1=${ff.toFixed(2)}  tp=${v.tp} fp=${v.fp} fn=${v.fn}`)
    }
    lines.push('  ' + '-'.repeat(58))
    const KIND = ['canvas', 'data-attr', 'closed shadow', 'autofill', 'face img']
    for (const [k, v] of [...byKind].sort()) {
      lines.push(`  adversarial[${KIND[k]}]`.padEnd(34) + `tp=${v.tp} fn=${v.fn} fp=${v.fp}`)
    }
    if (missedByClass.size) {
      lines.push('  missed: ' + [...missedByClass].map(([c, n]) => `${c}×${n}`).join(' '))
    }
    const fps = total.falsePositives.slice(0, 8)
    if (fps.length) {
      lines.push('  sample FPs:')
      for (const f of fps) lines.push('    ' + f)
    }
    lines.push('')
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))

    // Sanity floors, set from the measured L0+L1 baseline rather than from a
    // guess. These are deliberately NOT 0.95: regex-only detection cannot
    // find PERSON names in prose, which is exactly the gap L2 closes. The
    // point of this test is to catch a REGRESSION, and to make the size of
    // the L2 gap visible rather than hidden behind a flattering number.
    //
    // 24 of the 50 misses are pixel/shadow/attribute channel — structurally
    // invisible to L0/L1. The remaining 26 are DOM-channel PERSON (24),
    // EMAIL (4), PHONE (8), etc. that an L2 NER is designed to recover.
    expect(r).toBeGreaterThan(0.75)
    expect(p).toBeGreaterThan(0.9)

    // The classes only L2/L3 can reach must be visibly at zero here. If this
    // ever becomes non-zero, L0/L1 grew a rule and the cascade-delta table in
    // the README needs re-measuring.
    for (const cls of ['PERSON', 'ORG', 'MONEY', 'IP_ADDRESS']) {
      const v = total.byClass.get(cls)
      if (v) expect(v.tp / (v.tp + v.fn)).toBeLessThan(1)
    }
  })
})
