/**
 * Which object-detection architectures can this transformers.js actually run?
 *
 * Asked because the model-swap recommendation was "use yolov10n, it is 2.65 MB
 * and NMS-free" — and the runtime answered
 *   Unknown model class "yolov10", attempting to construct from base class
 *   Error: Missing the following inputs: images
 * so the repository resolves but the architecture does not load. A 49× smaller
 * model that cannot run is worth nothing, and the failure looks like a config
 * problem rather than an unsupported architecture.
 *
 *   npx vite-node bench/probe_detectors.ts
 */
import { env, AutoModel, AutoProcessor } from '@huggingface/transformers'
import { join } from 'node:path'

const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE

// Candidate person-capable detectors, cheapest first. Recorded with the reason
// each is in the list, because "we tried these" is the useful artefact.
const CANDIDATES = [
  { repo: 'onnx-community/yolov10n', why: 'the 2.65 MB recommendation' },
  { repo: 'Xenova/yolos-tiny', why: 'smallest YOLO in transformers.js' },
  { repo: 'onnx-community/detr-resnet-50-ONNX', why: 'what we ship today' },
  { repo: 'Xenova/detr-resnet-50', why: 'the original DETR export' },
  { repo: 'onnx-community/rtdetr_r18vd', why: 'NMS-free RT-DETR, if it loads' },
  { repo: 'Xenova/owlvit-base-patch32', why: 'open-vocab, would allow a real face class' },
  { repo: 'Xenova/owlvit-tiny', why: 'smallest open-vocab detector' },
]

async function main(): Promise<void> {
  console.log('\n  DETECTOR LOADABILITY — does the runtime support this architecture?')
  console.log('  ' + '='.repeat(72))

  for (const c of CANDIDATES) {
    const t0 = Date.now()
    let verdict = 'UNKNOWN'
    let detail = ''
    try {
      const model = await AutoModel.from_pretrained(c.repo, { dtype: 'q8' } as never)
      const proc = await AutoProcessor.from_pretrained(c.repo)
      // A model can load and still not run. Exercise it with a blank image so
      // the input names are actually checked.
      const { RawImage } = await import('@huggingface/transformers')
      const img = new RawImage(new Uint8ClampedArray(3 * 64 * 64).fill(128), 64, 64, 3)
      const inputs = await proc(img)
      const out = await model(inputs as never)
      const keys = Object.keys(out as Record<string, unknown>).join(',')
      // Time it warm, on the same synthetic image, so the comparison between
      // candidates is like-for-like rather than a cold-start artefact.
      await model(inputs as never)
      const ts: number[] = []
      for (let i = 0; i < 3; i++) {
        const t = Date.now()
        await model(inputs as never)
        ts.push(Date.now() - t)
      }
      ts.sort((a, b) => a - b)
      verdict = 'RUNS'
      detail = `${keys}  warm median ${ts[1]} ms`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/Unknown model class/i.test(msg)) {
        verdict = 'UNSUPPORTED ARCHITECTURE'
        detail = msg.split('\n')[0]!.slice(0, 90)
      } else if (/Missing the following inputs/i.test(msg)) {
        verdict = 'LOADS BUT NO OUTPUT'
        detail = msg.split('\n')[0]!.slice(0, 90)
      } else if (/404|not found|Repository Not Found/i.test(msg)) {
        verdict = 'NO SUCH REPO'
        detail = msg.split('\n')[0]!.slice(0, 90)
      } else {
        verdict = 'ERROR'
        detail = msg.split('\n')[0]!.slice(0, 90)
      }
    }
    const mark = verdict === 'RUNS' ? 'OK  ' : '--  '
    console.log(`  ${mark} ${c.repo.padEnd(42)} ${verdict}`)
    if (detail) console.log(`        ${detail}`)
    console.log(`        (${((Date.now() - t0) / 1000).toFixed(1)}s) why: ${c.why}`)
  }
  console.log('  ' + '='.repeat(72))
  console.log('  Only "RUNS" is usable. A repo that resolves proves nothing.\n')
}

void main()
