/**
 * Detection bridge — runs the REAL extension detector over one corpus form and
 * prints JSON for bench/run_metrics.py to score.
 *
 * This exists so the Python metric runner scores the same program that ships
 * in the extension, rather than a Python reimplementation of the rules. A
 * reimplementation would be a different detector and its numbers would be a
 * fiction.
 *
 *   npx vite-node bench/emit_detections.ts --form syn_00
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { hitsFromElement, runL1, fuseUnion, type ElementLike, type RawHit } from '../lib/pii'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')

const argv = process.argv.slice(2)
const all = argv.includes('--all')
const formId = argv.includes('--form') ? argv[argv.indexOf('--form') + 1] : undefined

if (!all && !formId) {
  console.error('usage: emit_detections.ts --form syn_00 | --all')
  process.exit(2)
}

const idx = JSON.parse(readFileSync(join(CORPUS, 'index.json'), 'utf-8')) as {
  forms: Array<{ id: string; json: string }>
}

/** Run the real detector over one form and return its hits, keyed by node. */
function detectForm(id: string, jsonFile: string): { hits: RawHit[]; byNode: Record<string, RawHit[]> } {
  const meta = JSON.parse(readFileSync(join(CORPUS, jsonFile), 'utf-8')) as { html: string }
  const html = readFileSync(join(CORPUS, meta.html), 'utf-8')
  const doc = new JSDOM(html).window.document

  const hits: RawHit[] = []
  const byNode: Record<string, RawHit[]> = {}

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    const nodeId = el.id || `${tag}:${el.getAttribute('name') ?? ''}`

    const dataAttrs: Record<string, string> = {}
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value

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
    // Free text in leaf elements goes through L1, exactly as content.ts does.
    if (el.children.length === 0 && el.textContent) {
      for (const h of runL1(el.textContent)) found.push({ ...h, nodeId })
    }
    const fused = fuseUnion(found)
    if (fused.length) {
      hits.push(...fused)
      ;(byNode[nodeId] ??= []).push(...fused)
    }
  }
  return { hits, byNode }
}

// `--all` processes the whole corpus in one process: spawning vite-node per
// form costs ~3s each and dominates the metric runner's runtime.
if (all) {
  const forms: Record<string, unknown> = {}
  for (const f of idx.forms) {
    forms[f.id] = detectForm(f.id, f.json)
  }
  process.stdout.write(JSON.stringify({ forms }))
} else {
  const entry = idx.forms.find((f) => f.id === formId)
  if (!entry) {
    console.error(`unknown form ${formId}`)
    process.exit(2)
  }
  const { hits, byNode } = detectForm(entry.id, entry.json)
  process.stdout.write(
    JSON.stringify({
      form: entry.id,
      hits: hits.map((h) => ({ cls: h.cls, source: h.source, score: h.score, nodeId: h.nodeId, text: h.text })),
      byNode,
    }),
  )
}
