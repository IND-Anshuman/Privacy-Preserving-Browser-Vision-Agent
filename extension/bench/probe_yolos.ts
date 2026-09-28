/**
 * Does yolos-tiny actually find a person, and what is its output shape?
 *
 * The swap candidate. yolov10n is 2.65 MB but does NOT run —
 * `Unknown model class "yolov10"` then `Missing the following inputs: images`
 * (see bench/probe_detectors.ts). yolos-tiny loads and executes, and is
 * 9.66 MB q8 against DETR's 42.96 MB.
 *
 * Before adopting it we need two things measured, not assumed:
 *   1. the output tensor shape, so the parser is written against reality
 *   2. whether a person is actually detected, and whether the box is sane
 *
 *   npx vite-node bench/probe_yolos.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { env, AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers'

const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE

const REPO = 'Xenova/yolos-tiny'

/** A person-ish silhouette: head + shoulders against a flat background. */
function makePortrait(): RawImage {
  const W = 480
  const H = 640
  const data = new Uint8ClampedArray(W * H * 3)
  const set = (x: number, y: number, v: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 3
    data[i] = v[0]!
    data[i + 1] = v[1]!
    data[i + 2] = v[2]!
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, [200, 205, 210])
  const ell = (cx: number, cy: number, rx: number, ry: number, v: [number, number, number]) => {
    for (let y = cy - ry; y <= cy + ry; y++)
      for (let x = cx - rx; x <= cx + rx; x++) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy <= 1) set(x, y, v)
      }
  }
  ell(240, 190, 70, 85, [220, 175, 145])   // head
  ell(240, 400, 130, 170, [50, 70, 140])   // torso
  return new RawImage(data, W, H, 3)
}

async function main(): Promise<void> {
  console.log('\n  YOLOS-TINY PROBE — loadable, and does it see a person?')
  console.log('  ' + '='.repeat(70))

  const model = await AutoModel.from_pretrained(REPO, { dtype: 'q8' } as never)
  const processor = await AutoProcessor.from_pretrained(REPO)
  const image = makePortrait()
  const inputs = await processor(image)

  // Warm, then timed: the first call pays graph construction.
  await model(inputs as never)
  const times: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    const out = await model(inputs as never)
    times.push(performance.now() - t0)
    if (i === 0) report(out)
  }
  const med = times.slice().sort((a, b) => a - b)[1]!
  console.log(`\n  warm inference: ${times.map((t) => t.toFixed(0)).join(', ')} ms  (median ${med.toFixed(0)} ms)`)

  mkdirSync(join(__dirname, '..', '..', 'bench', 'results'), { recursive: true })
  writeFileSync(
    join(__dirname, '..', '..', 'bench', 'results', 'yolos_probe.json'),
    JSON.stringify({ repo: REPO, warm_ms: times.map((t) => Math.round(t)), median_ms: Math.round(med) }, null, 2),
  )
  console.log('  wrote results/yolos_probe.json\n')
}

function report(out: unknown): void {
  const o = out as Record<string, { dims?: number[]; data?: ArrayLike<number> }>
  console.log('  output keys:', Object.keys(o).join(', '))
  for (const [k, v] of Object.entries(o)) {
    console.log(`    ${k.padEnd(12)} dims=[${(v.dims ?? []).join(',')}]  values=${v.data?.length ?? 0}`)
  }
  // YOLO-style: logits [batch, anchors, 84] = 4 bbox + 80 class scores.
  const logits = o.logits
  if (!logits?.dims || logits.dims.length !== 3) return
  const [b = 0, anchors = 0, ch = 0] = logits.dims
  console.log(`\n  logits [${b}, ${anchors}, ${ch}] — ${anchors} candidate anchors`)
  const d = logits.data!
  const rows: Array<{ score: number; cls: number; box: number[] }> = []
  for (let a = 0; a < anchors; a++) {
    const o0 = a * ch
    let best = 0
    let bestScore = 0
    for (let c = 0; c < ch - 4; c++) {
      const s = Number(d[o0 + 4 + c]!)
      if (s > bestScore) { bestScore = s; best = c }
    }
    if (bestScore > 0.05) {
      rows.push({
        score: bestScore,
        cls: best,
        box: [Number(d[o0]), Number(d[o0 + 1]), Number(d[o0 + 2]), Number(d[o0 + 3])],
      })
    }
  }
  rows.sort((a, b) => b.score - a.score)
  console.log(`  ${rows.length} anchors above 0.05; top 5:`)
  for (const r of rows.slice(0, 5)) {
    console.log(`    cls=${String(r.cls).padStart(2)} score=${r.score.toFixed(3)} box=[${r.box.map((v) => v.toFixed(0)).join(', ')}]`)
  }
  // COCO 0 = person. Scores may be logits rather than probabilities, so check
  // both readings before concluding anything.
  const persons = rows.filter((r) => r.cls === 0)
  console.log(`\n  class 0 (person) anchors: ${persons.length}`)
  if (persons[0]) {
    console.log(`  best person score ${persons[0]!.score.toFixed(3)}  box=[${persons[0]!.box.map((v) => v.toFixed(0)).join(', ')}]`)
    console.log('  (the drawn figure spans x 110..370, y 105..570)')
  } else {
    console.log('  NO person detected — the silhouette is not enough for this model.')
  }
}

void main()
