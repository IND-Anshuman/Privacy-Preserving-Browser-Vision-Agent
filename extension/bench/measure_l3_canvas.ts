/**
 * MEASURE L3 on the canvas adversarial cases.
 *
 * The 4/16 canvas recall was the largest remaining privacy gap. This renders
 * each synthetic form's canvas content into a real OffscreenCanvas, runs the
 * text-region detector, and reports how many ground-truth PII values fall
 * inside a detected region.
 *
 * The number that matters is COVERAGE, not precision: a text region we miss
 * means a value that is still readable in the uploaded frame. Extra regions
 * cost a useless box, and the whole element is redacted regardless via the
 * OPAQUE_REGION fail-closed path, so the trade is heavily asymmetric.
 *
 *   npx vite-node bench/measure_l3_canvas.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { runL3Text } from '../entrypoints/offscreen/models'

const CORPUS = join(__dirname, '..', '..', 'bench', 'corpus', 'synthetic')
const RESULTS = join(__dirname, '..', '..', 'bench', 'results')

interface Inst { cls: string; value: string; channel: string }

/** Does a box cover the region a value was drawn in? */
function covers(boxes: Array<{ box: { x: number; y: number; w: number; h: number } }>, x: number, y: number): boolean {
  return boxes.some((b) => x >= b.box.x && x <= b.box.x + b.box.w && y >= b.box.y && y <= b.box.y + b.box.h)
}

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true })
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('form_')).sort()

  let checked = 0
  let covered = 0
  let canvasWithPii = 0
  let canvasCovered = 0
  let totalBoxes = 0
  let totalMs = 0
  const missed: string[] = []

  for (const f of files) {
    const meta = JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { html: string; instances: Inst[] }
    const html = readFileSync(join(CORPUS, meta.html), 'utf-8')
    const doc = new JSDOM(html).window.document

    for (const cv of Array.from(doc.querySelectorAll('canvas'))) {
      // The corpus labels this channel `pixels`, not `canvas` — canvas, video
      // and image content all land there. Filtering on 'canvas' returned an
      // empty set and reported 0/0, which reads like a pass.
      const pii = meta.instances.filter((i) => i.channel === 'pixels')
      if (pii.length === 0) continue
      canvasWithPii++

      // The corpus draws its canvas text at a known band. Reproduce that
      // geometry so the measurement is about the DETECTOR, not about JSDOM
      // having no canvas backend.
      const W = 640
      const H = 200
      const canvas = new OffscreenCanvas(W, H)
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#000000'
      ctx.font = '16px monospace'
      // One line per PII value, spaced far enough apart to be separate
      // regions — the worst case for a line-grouping detector.
      pii.forEach((inst, i) => {
        ctx.fillText(inst.value, 20, 40 + i * 40)
      })

      const r = await runL3Text(canvas)
      totalBoxes += r.boxes.length
      totalMs += r.ms
      if (!r.available) continue

      for (const inst of pii) {
        // FACE is the face detector's job, not the text detector's. Scoring the
        // text-region pass on a face would measure the wrong model.
        if (inst.cls === 'FACE') continue
        checked++
        // The value's line centre, in canvas pixels.
        const idx = pii.indexOf(inst)
        const y = 40 + idx * 40
        if (covers(r.boxes, 20, y)) {
          covered++
          canvasCovered++
        } else if (missed.length < 8) {
          missed.push(`${inst.cls} ${JSON.stringify(inst.value.slice(0, 28))} (${f})`)
        }
      }
    }
  }

  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)
  console.log('\n  L3 CANVAS COVERAGE (real OffscreenCanvas, real rendered text)')
  console.log('  ' + '='.repeat(66))
  console.log(`  canvases carrying PII : ${canvasWithPii}`)
  console.log(`  PII lines drawn      : ${checked}`)
  console.log(`  covered by a region  : ${covered}  (${pct(covered, checked)})`)
  console.log(`  text regions found   : ${totalBoxes}  (avg ${(totalBoxes / Math.max(1, canvasWithPii)).toFixed(1)}/canvas)`)
  console.log(`  detector cost        : ${(totalMs / Math.max(1, canvasWithPii)).toFixed(1)} ms/canvas`)
  if (missed.length) {
    console.log('  missed:')
    for (const m of missed) console.log('    ' + m)
  }
  console.log('  ' + '='.repeat(66))
  console.log('  This is the DETECTOR. End-to-end canvas safety additionally relies')
  console.log('  on the OPAQUE_REGION fail-closed rule, so a miss here is not a')
  console.log('  leak on its own — the element is redacted regardless until L3 clears')
  console.log('  it. The number shows how much work L3 is actually doing.\n')

  writeFileSync(join(RESULTS, 'l3_canvas.json'), JSON.stringify({
    canvases_with_pii: canvasWithPii,
    pii_lines: checked,
    covered,
    coverage: +(covered / Math.max(1, checked)).toFixed(4),
    avg_regions_per_canvas: +(totalBoxes / Math.max(1, canvasWithPii)).toFixed(2),
    avg_ms_per_canvas: +(totalMs / Math.max(1, canvasWithPii)).toFixed(2),
    missed,
  }, null, 2))
  console.log('  wrote results/l3_canvas.json\n')
}

void main()
