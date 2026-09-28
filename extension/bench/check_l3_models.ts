import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Are the L3 models actually the right tools? Checked against the Hub, not assumed.
 *
 * Two suspicions, both of which would make L3 useless while looking configured:
 *   1. yolov10n is a COCO detector. COCO has 80 classes and "face" is not one
 *      of them, so it cannot be a face detector however well it runs.
 *   2. trocr-small-printed at 787 MB is far too heavy for a client that must
 *      respect a 200 MB heap budget, and it is a RECOGNISER, not a detector.
 *
 * Writes the verdict to bench/results/l3_models.json.
 */
const CACHE = process.env.VEIL_MODEL_CACHE ?? join(process.env.LOCALAPPDATA ?? '.', 'veil-models')
const HF = 'https://huggingface.co'

interface Check { id: string; repo: string; exists: boolean; files: string[]; sizeBytes: number; labels?: string[]; verdict: string }

async function head(url: string): Promise<Response | null> {
  try { return await fetch(url, { method: 'HEAD' }) } catch { return null }
}
async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try { const r = await fetch(url); return r.ok ? (await r.json()) as Record<string, unknown> : null } catch { return null }
}

async function check(id: string, repo: string, labelFile?: string): Promise<Check> {
  const exists = (await head(`${HF}/${repo}/resolve/main/config.json`))?.ok ?? false
  const files: string[] = []
  let sizeBytes = 0
  if (exists) {
    const r = await fetch(`${HF}/api/models/${repo}?blobs=true`)
    if (r.ok) {
      const meta = (await r.json()) as { siblings?: Array<{ rfilename: string; size?: number }> }
      for (const s of meta.siblings ?? []) {
        files.push(s.rfilename)
        if (/\.onnx$/.test(s.rfilename) && s.size) sizeBytes += s.size
      }
    }
  }
  let labels: string[] | undefined
  if (labelFile && exists) {
    const cfg = await getJson(`${HF}/${repo}/resolve/main/${labelFile}`)
    const raw = cfg?.labels ?? (cfg?.id2label as unknown)
    if (Array.isArray(raw)) labels = raw.map(String)
    else if (raw && typeof raw === 'object') labels = Object.values(raw as Record<string, string>).map(String)
  }
  return { id, repo, exists, files, sizeBytes, labels, verdict: '' }
}

async function main(): Promise<void> {
  const checks: Check[] = []
  checks.push(await check('l3face', 'onnx-community/yolov10n', 'id2label.json'))
  checks.push(await check('l3ocr', 'Xenova/trocr-small-printed'))
  checks.push(await check('blazeface', 'onnx-community/blazeface', 'id2label.json'))
  checks.push(await check('dbnet', 'onnx-community/deep-text-recognition-...' /* placeholder */))

  console.log('\n  L3 MODEL CHECK')
  console.log('  ' + '='.repeat(70))
  for (const c of checks) {
    console.log(`  ${c.id.padEnd(10)} ${c.repo}`)
    console.log(`     exists=${c.exists}  onnx=${(c.sizeBytes / 1048576).toFixed(1)} MB  files=${c.files.length}`)
    if (c.labels) {
      console.log(`     labels(${c.labels.length}): ${c.labels.slice(0, 12).join(', ')}${c.labels.length > 12 ? ' ...' : ''}`)
      console.log(`     has "face"? ${c.labels.some((l) => /face|person|head/i.test(l)) ? 'YES' : 'NO'}`)
    }
  }
  console.log('  ' + '='.repeat(70))
  writeFileSync(join(__dirname, '..', '..', 'bench', 'results', 'l3_models.json'), JSON.stringify(checks, null, 2))
  console.log('  wrote results/l3_models.json\n')
}

void main()
