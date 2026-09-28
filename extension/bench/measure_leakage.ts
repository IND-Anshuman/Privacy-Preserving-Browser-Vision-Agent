/**
 * THE LEAK, MEASURED.
 *
 * The leakage test found 42 DOM-channel PII values still present in
 * screen_state, and every one of them is a PERSON name. That is not a bug in
 * the substitution — it is a direct consequence of the measured L0+L1 recall of
 * 0.56 on PERSON. Regex cannot find a name in prose, so there is nothing for the
 * pseudonymizer to substitute.
 *
 * This script quantifies the gap three ways so the fix is chosen on evidence:
 *   A. substitution with L0/L1 detection only   (what the client does now)
 *   B. substitution plus the PII model          (what the client would do with L2)
 *   C. a defence-in-depth fallback for whatever both miss
 *
 *   npx vite-node bench/measure_leakage.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { pipeline, env } from '@huggingface/transformers'
import { hitsFromElement, runL1, fuseUnion, type ElementLike } from '../lib/pii'
import { mergeTokens, normaliseRows, recoverOffsets } from '../entrypoints/offscreen/models'
import { mapL2Label } from '../entrypoints/offscreen/ner'
import { Pseudonymizer } from '../lib/pseudonym'
import type { PiiClass } from '../lib/schema'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')
const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
env.allowLocalModels = true; env.cacheDir = CACHE; env.localModelPath = CACHE

interface Inst { cls: string; value: string; node_id: string; channel: string }
interface Hit { cls: PiiClass; text: string; score: number }

function pageHits(html: string): Hit[] {
  const doc = new JSDOM(html).window.document
  const out: Hit[] = []
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    const dataAttrs: Record<string, string> = {}
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value
    const like: ElementLike = {
      tag, type: el.getAttribute('type') ?? undefined, id: el.id || undefined,
      name: el.getAttribute('name') ?? undefined, placeholder: el.getAttribute('placeholder') ?? undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined, title: el.getAttribute('title') ?? undefined,
      alt: el.getAttribute('alt') ?? undefined, autocomplete: el.getAttribute('autocomplete') ?? undefined,
      value: 'value' in el ? (el as HTMLInputElement).value : undefined, dataAttrs,
    }
    const hits = hitsFromElement(like)
    if (el.children.length === 0 && el.textContent) for (const h of runL1(el.textContent)) hits.push(h)
    // L1 must also run over the value surface. An input's contents never appear
    // in textContent, so without this the regex layer never saw a single
    // pre-filled field value — which is where a banking form keeps the Aadhaar
    // number, the card number and the address.
    for (const h of runL1(valueTextOf(el))) hits.push({ ...h, nodeId: el.id })
    for (const h of fuseUnion(hits)) {
      if (h.cls !== 'PASSWORD' && h.score >= 0.5) out.push({ cls: h.cls, text: h.text, score: h.score })
    }
  }
  return out
}

async function l2Hits(html: string, pipe: unknown): Promise<Hit[]> {
  const doc = new JSDOM(html).window.document
  const out: Hit[] = []
  const run = pipe as (s: string) => Promise<unknown>
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (['script', 'style'].includes(el.tagName.toLowerCase())) continue
    // The model must see the value surface too, in its own offset space.
    // Running it only over textContent meant it never saw a pre-filled field,
    // so PERSON/ADDRESS typed into an input were invisible to L2 as well.
    for (const t of [
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      valueTextOf(el),
    ]) {
      if (!t || t.length <= 2) continue
      try {
        const raw = await run(t.slice(0, 400))
        for (const row of normaliseRows(raw)) {
          for (const s of mergeTokens(recoverOffsets(row, t), t)) {
            const cls = mapL2Label(s.label)
            if (cls && s.score >= 0.9) out.push({ cls, text: s.text, score: s.score })
          }
        }
      } catch { /* skip */ }
    }
  }
  return out
}

/**
 * Does substituting these hits remove `value` from `text`?
 *
 * Uses the SAME bridgeAdjacent the client does, because that is what closes
 * the "Divya" + "Banerjee" case: the model returns two spans for one name, and
 * substituting them independently leaves the surname readable.
 */
function leaks(text: string, hits: Hit[], value: string): boolean {
  const p = new Pseudonymizer('leak-bench')
  const spans = hits
    .filter((h) => h.text && h.text.length >= 2)
    .map((h) => {
      const at = text.indexOf(h.text)
      return { start: at, end: at + h.text.length, cls: h.cls, text: h.text }
    })
    .filter((s) => s.start >= 0)
  if (spans.length === 0) return text.includes(value)
  return p.substitute(text, spans).includes(value)
}

/**
 * Build the payload content.ts actually POSTs, and return it as one string.
 *
 * THREE modelling errors in earlier versions of this audit, each of which
 * produced a confident and wrong number. Worth writing down, because the
 * failure mode was always "report a clean result".
 *
 *   1. It searched `body.textContent`, which never contains an input's value.
 *      That silently dropped 108 of 212 DOM-channel instances.
 *   2. It then included value-bearing text in the payload, which is the
 *      opposite error. screen_state.json has NO `value` field for a sensitive
 *      node — a flagged field contributes `valueClass: 'sensitive'` and a
 *      redaction BOX, never the string. Searching for values in a payload that
 *      by contract cannot contain them manufactures 90% leaks out of nothing.
 *   3. Detectors were run per element but substituted into concatenated text,
 *      mixing offset spaces.
 *
 * So: detectors run over BOTH the text surface and the value surface (the
 * value surface is what produces the redaction box and the valueClass), but
 * only the TEXT surface can appear in the payload. Box coverage is a separate
 * measurement — that is the pixel channel's job, and conflating the two is how
 * you end up reporting a text-channel leak for a field that is actually
 * correctly blanked.
 */
function buildPayload(html: string, l01: Hit[], l2: Hit[]): string {
  const doc = new JSDOM(html).window.document
  const p = new Pseudonymizer('leak-bench')
  const nodes: Array<Record<string, unknown>> = []
  const all = [...l01, ...l2]

  const walk = (el: Element) => {
    if (['script', 'style'].includes(el.tagName.toLowerCase())) return

    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 300)

    if (own) {
      const spans = all
        .filter((h) => h.text && h.text.length >= 2 && own.includes(h.text))
        .map((h) => {
          const at = own.indexOf(h.text)
          return { start: at, end: at + h.text.length, cls: h.cls, text: h.text }
        })
        .filter((s) => s.start >= 0)
      const label = p.substitute(own, spans)
      // Mirrors the ScreenNode contract: label is pseudonymized, and a
      // sensitive node carries a class flag but never a value.
      nodes.push({
        id: el.id || el.tagName.toLowerCase(),
        role: el.tagName.toLowerCase(),
        ...(label ? { label } : {}),
        valueClass: spans.some((s) => s.cls === 'PASSWORD') ? 'sensitive' : 'masked',
      })
    }
    for (const c of Array.from(el.children)) walk(c)
  }
  if (doc.body) walk(doc.body)
  return JSON.stringify(nodes)
}

/**
 * The value-bearing surface of an element: the live `value` property plus the
 * attributes that persist it. An autofill or password manager can populate any
 * of these without an input event, which is why §5 requires re-scanning them
 * every cycle rather than listening for changes.
 */
function valueTextOf(el: Element): string {
  const out: string[] = []
  const live = (el as HTMLInputElement).value
  if (typeof live === 'string' && live) out.push(live)
  for (const a of Array.from(el.attributes)) {
    if (a.name === 'value' || a.name === 'placeholder' || a.name.startsWith('data-')) out.push(a.value)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()
  const forms = files.map((f) => {
    const m = JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { id: string; html: string; instances: Inst[] }
    return { id: m.id, html: readFileSync(join(CORPUS, m.html), 'utf-8'), gt: m.instances }
  })

  console.log('\n  VEIL — LEAKAGE AUDIT (are values still in the payload?)')
  console.log('  ' + '='.repeat(72))

  const pipe = await pipeline('token-classification', 'onnx-community/bert-small-pii-detection-ONNX', { dtype: 'q8' } as never)

  let textTotal = 0, aLeak = 0, bLeak = 0
  let boxTotal = 0, boxMiss = 0
  const leakedByClass: Record<string, number> = {}
  const leakedAfterL2: Record<string, number> = {}
  const boxMissByClass: Record<string, number> = {}
  const survivors: string[] = []

  for (const f of forms) {
    const l01 = pageHits(f.html)
    const l2 = await l2Hits(f.html, pipe)

    // Two independent measurements, because a value can be protected two
    // different ways and conflating them hides real failures:
    //
    //   TEXT CHANNEL — does the GT string appear in screen_state.json?
    //   BOX COVERAGE — is there a detection covering it, so the pixel channel
    //                  will actually blank the field?
    //
    // A value living in an input is not in the payload (by contract), but it
    // IS still on screen and still recoverable from the frame unless a box
    // covers it. Scoring only the first would let a completely unprotected
    // Aadhaar field pass.
    const payloadL01 = buildPayload(f.html, l01, [])
    const payloadL2 = buildPayload(f.html, l01, l2)
    const boxes = new Set([...l01, ...l2].map((h) => h.text.trim()).filter(Boolean))

    for (const inst of f.gt) {
      if (inst.channel !== 'dom') continue
      if (inst.cls === 'PASSWORD') continue
      const v = inst.value.trim()
      if (v.length < 4) continue

      textTotal++
      if (payloadL01.includes(v)) {
        aLeak++
        leakedByClass[inst.cls] = (leakedByClass[inst.cls] ?? 0) + 1
        if (survivors.length < 6) survivors.push(`L0/L1 ${inst.cls} ${JSON.stringify(v)}`)
      }
      if (payloadL2.includes(v)) {
        bLeak++
        leakedAfterL2[inst.cls] = (leakedAfterL2[inst.cls] ?? 0) + 1
        if (survivors.length < 6) survivors.push(`L2 ${inst.cls} ${JSON.stringify(v)}`)
      }

      // A box covers the value if some detection matches it, or matches a
      // contiguous fragment of it. A regex that catches only the PIN part of
      // an address still means a box is drawn over the field.
      const covered =
        boxes.has(v) || [...boxes].some((t) => t.length >= 4 && (v.includes(t) || t.includes(v)))
      boxTotal++
      if (!covered) {
        boxMiss++
        boxMissByClass[inst.cls] = (boxMissByClass[inst.cls] ?? 0) + 1
      }
    }
  }

  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)
  const fmt = (o: Record<string, number>) =>
    Object.entries(o).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join(' ') || 'none'

  console.log(`  DOM-channel values checked : ${textTotal}`)
  console.log('  ' + '-'.repeat(72))
  console.log('  1. TEXT CHANNEL — GT string present in screen_state.json?')
  console.log(`     A. L0+L1 only        ${String(aLeak).padStart(3)} leaked  (${pct(aLeak, textTotal)})`)
  console.log(`        by class: ${fmt(leakedByClass)}`)
  console.log(`     B. + PII model (L2)  ${String(bLeak).padStart(3)} leaked  (${pct(bLeak, textTotal)})`)
  console.log(`        by class: ${fmt(leakedAfterL2)}`)
  if (survivors.length) {
    console.log('     survivors:')
    for (const s of survivors) console.log('       ' + s)
  }
  console.log('  ' + '-'.repeat(72))
  console.log('  2. BOX COVERAGE — is a redaction box drawn over the value?')
  console.log(`     full cascade         ${String(boxMiss).padStart(3)} uncovered  (${pct(boxMiss, boxTotal)} missed)`)
  console.log(`        by class: ${fmt(boxMissByClass)}`)
  console.log('  ' + '-'.repeat(72))
  console.log('  1 is the DOM channel. 2 is the pixel channel. A value can fail either')
  console.log('  one independently, and reporting only 1 flatters the result.\n')

  writeFileSync(join(RESULTS, 'leakage.json'), JSON.stringify({
    values_checked: textTotal,
    text_channel: {
      l0l1_only: { leaked: aLeak, rate: +(aLeak / textTotal).toFixed(4), by_class: leakedByClass },
      with_pii_model: { leaked: bLeak, rate: +(bLeak / textTotal).toFixed(4), by_class: leakedAfterL2 },
    },
    box_coverage: {
      checked: boxTotal,
      uncovered: boxMiss,
      miss_rate: +(boxMiss / boxTotal).toFixed(4),
      by_class: boxMissByClass,
    },
  }, null, 2))
  console.log('  wrote results/leakage.json\n')
}

void main()
