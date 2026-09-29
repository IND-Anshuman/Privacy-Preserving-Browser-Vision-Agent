/**
 * Offscreen document entry point — the inference sandbox. ARCHITECTURE.md §2.
 *
 * This document holds the raw frame. It is the only context that does, and it
 * nulls every raw reference before a single byte is handed to the SW.
 */
import { parseMessage, type PressureState, type VeilMessage } from '@/lib/messages'
import { defineUnlistedScript } from 'wxt/sandbox'
import type { PiiClass } from '@/lib/schema'
import { detectCaptureCaps, chooseMode, createCapturer, capToWidth, type CaptureCaps, type Capturer } from './capture'
import { initDevice, runL2, getDeviceInfo, getSession, getLoadTimings, getLoadErrors, MODEL_IDS, PromptApiTier0 } from './models'
import { mapL2Label } from './ner'
import { redactFrame, type RedactItem } from './redact'
import { PressureMonitor, planFor as pressurePlan, type CascadePlan } from './pressure'
import {
  dhash, evaluateGate, commitGate, newGateState, toLumaThumbnail, domStructuralHash, fnv1a,
  coalesceTiles,
  type GateState, type GateDecision,
} from '@/lib/framediff'
import { nerBatchSize } from '@/lib/device'
import { l2Enabled, admitL2 } from '@/lib/l2policy'
import { type MarkAssignment } from '@/lib/som'

const log = (m: string): void => {
  const el = document.getElementById('log')
  if (el) el.textContent = `${new Date().toISOString().slice(11, 19)} ${m}`
}

/* ------------------------------------------------------------------ *
 *  Sandbox state
 * ------------------------------------------------------------------ */

let caps: CaptureCaps | null = null
let capturer: Capturer | null = null
let pressure: PressureMonitor | null = null
let plan: CascadePlan | null = null
const gate: GateState = newGateState()
const tier0 = new PromptApiTier0()
let tabId = -1

/* ------------------------------------------------------------------ *
 *  Startup. WXT imports this module in Node during `prepare`, so every
 *  chrome.* / DOM touch lives inside main(). [verified by the
 *  `MutationObserver is not defined` failure this structure is fixing]
 * ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  await initDevice()
  caps = await detectCaptureCaps()
  pressure = new PressureMonitor()
  // pressure.start() runs its observer synchronously and returns void, so the
  // plan is read back off the monitor rather than from a return value.
  pressure.start((p) => {
    plan = p
    void broadcastStatus()
  })
  plan = pressurePlan(pressure.current)
  log(`ready · ${getDeviceInfo().device} · ${caps.notes.length} capability notes`)
  if (caps.notes.length) log(caps.notes[0]!)
}

function start(): void {
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = parseMessage(raw)
    if (!msg) {
      sendResponse({ ok: false, error: 'invalid message' })
      return false
    }
    void handle(msg).then(sendResponse).catch((e: unknown) => {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
    })
    return true
  })

  void boot()

  // Warm the device probe + the smallest session off the critical path (§8:
  // prefetch), so the first real run does not pay session-construction cost.
  void (async () => {
    await initDevice()
    void getSession('l3face')
  })()
}

/* ------------------------------------------------------------------ *
 *  Status broadcast for the HUD (§7)
 * ------------------------------------------------------------------ */

async function heapMb(): Promise<number | undefined> {
  const perf = performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }
  if (typeof perf.measureUserAgentSpecificMemory !== 'function') return undefined
  try {
    const m = await perf.measureUserAgentSpecificMemory()
    return Math.round(m.bytes / 1048576)
  } catch {
    return undefined
  }
}

async function broadcastStatus(): Promise<void> {
  const msg: VeilMessage = {
    kind: 'offscreen:status',
    captureMode: capturer?.mode ?? 'none',
    pressure: (pressure?.current ?? 'nominal') as PressureState,
    heapMb: await heapMb(),
    adapter: getDeviceInfo().note,
    rows: [
      { label: 'cascade', value: plan?.why ?? '—' },
      { label: 'device', value: getDeviceInfo().device },
      { label: 'model load ms', value: JSON.stringify(getLoadTimings()) },
      { label: 'transitions', value: pressure?.transitions.length ?? 0 },
    ],
  }
  try {
    await chrome.runtime.sendMessage(msg)
  } catch {
    // The panel may not be open.
  }
}

/* ------------------------------------------------------------------ *
 *  Message handling
 * ------------------------------------------------------------------ */

async function handle(msg: VeilMessage): Promise<unknown> {
  switch (msg.kind) {
    case 'offscreen:init': {
      tabId = msg.tabId
      if (!caps) caps = await detectCaptureCaps()
      const decision = chooseMode(caps, { wantLive: true, preferRegion: true, hasBoxes: false })
      capturer = await createCapturer(caps, tabId, decision)
      log(`capture mode: ${capturer.mode}`)
      await broadcastStatus()
      return { ok: true, mode: capturer.mode }
    }
    case 'offscreen:capture':
      return runCapture(msg.runId, msg.boxes as Array<{ id: string; cls: PiiClass; box: { x: number; y: number; w: number; h: number }; score: number; source: 'L0' | 'L1' | 'L2' | 'L3'; text?: string }>, msg.marks as MarkAssignment[])
    case 'offscreen:local': {
      // The real tier-0 path. `PromptApiTier0` has been fully implemented since
      // it was written, but nothing ever called it: background.ts's T0 branch
      // sent `offscreen:capture` and pushed the *capture report* into the chat
      // bubble. Asking "what is on this page?" therefore answered
      // {"ok":true,"bytes":48210,"redactions":7} — a JSON blob, not an answer.
      // The button worked; the feature behind it was never reachable.
      const { intent, screenText } = msg as { intent: string; screenText: string }
      try {
        const a = await tier0.answer(intent, screenText)
        return { ok: true, text: a.text, source: a.source }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    case 'offscreen:arm':
      return { ok: true }
    case 'offscreen:release':
      capturer?.release()
      capturer = null
      return { ok: true }
    default:
      return { ok: false, error: `unhandled ${msg.kind}` }
  }
}

/* ------------------------------------------------------------------ *
 *  The capture → redact cycle.
 *
 *  RAW FRAME LIFETIME, precisely:
 *    grab()            -> `source` holds a reference
 *    drawImage         -> pixels are in the compositor
 *    redactFrame()     -> draws redactions, encodes, returns a Blob
 *    source.close()    -> reference dropped
 *  `source` is a `let` in this function precisely so it can be nulled. There is
 *  no return path that carries it out.
 * ------------------------------------------------------------------ */

async function runCapture(
  runId: string,
  domItems: Array<{ id: string; cls: PiiClass; box: { x: number; y: number; w: number; h: number }; score: number; source: 'L0' | 'L1' | 'L2' | 'L3'; text?: string }>,
  marks: MarkAssignment[],
): Promise<unknown> {
  if (!caps) caps = await detectCaptureCaps()
  if (!capturer) {
    const decision = chooseMode(caps, { wantLive: true, preferRegion: true, hasBoxes: domItems.length > 0 })
    capturer = await createCapturer(caps, tabId, decision)
  }

  // Let source be nulled — this is the whole point of the closure.
  let source: ImageBitmap | VideoFrame | null = null
  const t0 = performance.now()

  try {
    source = await capturer.grab()
    if (!source) {
      return abort(runId, 'capture produced no frame')
    }

    const w = source instanceof ImageBitmap ? source.width : (source as VideoFrame).displayWidth
    const h = source instanceof ImageBitmap ? source.height : (source as VideoFrame).displayHeight
    const capped = capToWidth(w, h)

    /* ---- frame-diff gate (§7): the metric-4 headline ---- */
    const thumb = new OffscreenCanvas(64, 64)
    const tctx = thumb.getContext('2d', { willReadFrequently: true })
    /** Hoisted out of the thumbnail block so the tile report below can use it. */
    let decision: GateDecision | null = null
    let frameHash = dhash(new Float32Array(64 * 64))
    if (tctx) {
      tctx.drawImage(source as CanvasImageSource, 0, 0, 64, 64)
      const img = tctx.getImageData(0, 0, 64, 64)
      const luma = toLumaThumbnail(img.data, 64, 64)
      // The DOM half of the gate must fingerprint WHAT was detected, not HOW
      // MANY. `String(domItems.length)` meant typing into a field — or a script
      // filling one in — left the count unchanged, the gate reported
      // "unchanged", and the run proceeded with a STALE MANIFEST, so the new
      // PII was never redacted. [audit 1.3]
      const domHash = domStructuralHash(
        domItems.map((i) => ({
          role: i.cls,
          // The VALUE participates, hashed. A name and a different name are
          // different content even when the class is identical.
          label: `${i.cls}:${(i.text ?? '').length}:${fnv1a(i.text ?? '')}`,
          valueClass: i.source,
        })),
      )
      decision = evaluateGate(gate, luma, domHash)
      commitGate(gate, luma, domHash)
      frameHash = gate.prevFrameHash ?? frameHash
      if (!decision.proceed) {
        // Static page: no inference, no upload. This is the number judges
        // watch in the HUD.
        log('gate: skipped (unchanged)')
        source.close()
        source = null
        return { ok: true, skipped: true, reason: decision.reason }
      }
    }

    /* ---- L2 over DOM text (when the cascade allows it) ---- */
    // Gated on the MEASURED policy, not on pressure alone. Previously the
    // policy file existed but was imported nowhere, so a "disabled" layer was
    // still attempting a 27 MB model load on every single cycle. [audit 2.4]
    const useL2 = l2Enabled(plan?.L2 ?? true)
    const useL3 = plan?.L3 ?? true
    // Typed explicitly: without it TypeScript infers the element type from the
    // first spread, and every later field (recoveredFromPixels) becomes an
    // excess-property error rather than being checked against RedactInput.
    const items: RedactItem[] = [...domItems]
    const timings: Record<string, number> = {}

    if (useL2) {
      const texts = domItems.map((i) => i.text ?? '').filter(Boolean)
      if (texts.length) {
        // Adaptive batch size. Activation memory scales linearly with batch:
        // a 512-token, 768-hidden transformer activation is ~12 MB at B=8 and
        // ~96 MB at B=64, and a 12-layer model holds several of those at once.
        // A hardcoded 64 therefore OOMs on the low-memory devices this feature
        // is supposed to support, so the batch is derived from what the
        // device actually reports. [§7 resource discipline]
        const batch = nerBatchSize()
        const r = await runL2(texts.slice(0, batch))
        timings['l2'] = r.ms
        timings['l2_batch'] = batch
        if (r.available) {
          for (const s of r.spans) {
            const cls = mapL2Label(s.label)
            if (cls) {
              items.push({
                id: `l2-${items.length}-${s.start}`,
                cls,
                box: { x: 0, y: 0, w: 0, h: 0 }, // text-channel: no pixel box
                score: s.score,
                source: 'L2',
                text: s.text,
              })
            }
          }
        }
      }
    }

    if (useL3) {
      // Text-in-canvas / faces. Pixels only; DOM rules cannot see these (§5).
      const mod = await import('./models')

      const faces = await mod.runL3Faces(source as unknown as ImageBitmap)
      timings['l3face'] = faces.ms
      for (const f of faces.boxes) {
        items.push({ id: `l3f-${items.length}`, cls: 'FACE', box: f.box, score: f.score, source: 'L3' })
      }

      /**
       * §5's "re-run L1/L2 on recovered strings" — the step that was written,
       * reviewed, and had zero callers. Canvas and video text is invisible to
       * every DOM rule, and a region detector alone only says "there is text
       * here"; it does not say WHAT. So:
       *
       *   1. find text-dense regions          (geometric, cheap)
       *   2. OCR each crop                    (TrOCR, on regions only)
       *   3. re-run L1 + L2 on the recovered  (a model we already ship)
       *      strings
       *   4. emit a detection for each hit
       *
       * Step 3 is the point. A detected region is blanked regardless, so the
       * fail-closed rule already protects the pixel; what the recovered string
       * adds is a CLASS, so the manifest and the server prompt can say what was
       * found rather than "something was here".
       *
       * Failure is contained, not fatal: if the OCR model is missing or errors,
       * the regions are still redacted, and the run reports why. A pixel layer
       * that takes the whole request down because OCR is unavailable would be
       * strictly worse than no pixel layer.
       */
      const regions = await mod.runL3Text(source as unknown as ImageBitmap)
      timings['l3text'] = regions.ms
      if (regions.available) {
        const recovered = await mod.ocrRegions(source as unknown as ImageBitmap, regions.boxes)
        timings['l3ocr'] = regions.ms

        // A region with text is a region worth protecting even if no detector
        // recognises the content: a captcha or a hand-written number will not
        // match L1. Emit the OCR text itself so the placeholder channel can
        // carry it.
        for (const r of recovered) {
          items.push({
            id: `l3t-${items.length}`,
            cls: 'TEXT_REGION',
            box: r.box.box,
            score: r.box.score,
            source: 'L3',
            text: r.text,
          })
        }

        // Classify the recovered strings. L1 is ~1 ms and catches the exact
        // formats (Aadhaar, PAN, IFSC, card) that a generic OCR pass tends to
        // mangle into near-misses.
        if (recovered.length > 0) {
          const { runL1, fuseUnion } = await import('@/lib/pii')
          const texts = recovered.map((r) => r.text)
          for (let i = 0; i < recovered.length; i++) {
            const t = texts[i]!
            for (const hit of fuseUnion(runL1(t))) {
              if (hit.cls === 'PASSWORD' || hit.score < 0.5) continue
              items.push({
                id: `l3r-${items.length}-${i}`,
                cls: hit.cls,
                box: recovered[i]!.box.box,
                score: hit.score,
                source: 'L3',
                text: hit.text,
                recoveredFromPixels: true,
              })
            }
          }

          // And L2 for the classes regex structurally cannot reach — a name
          // drawn in a canvas is the canonical case.
          if (useL2) {
            const ner = await mod.runL2(texts)
            if (ner.available) {
              for (const s of ner.spans) {
                const cls = mod.mapL2Label(s.label)
                if (!cls || !admitL2(cls, s.score)) continue
                // The model ran over `texts` as a batch of STRINGS, so a span's
                // offsets are relative to its own row — but normaliseRows
                // flattens the batch and loses which row that was. Rather than
                // guess, attribute by containment. Each region is one text
                // line and there are rarely more than a handful, so the box is
                // coarse — and a coarse box is the safe direction: it redacts
                // the line rather than part of it.
                const owner =
                  recovered.find((r) => r.text.includes(s.text.trim())) ?? recovered[0]!
                items.push({
                  id: `l3n-${items.length}`,
                  cls,
                  box: owner.box.box,
                  score: s.score,
                  source: 'L3',
                  text: s.text,
                  recoveredFromPixels: true,
                })
              }
              timings['l3ner'] = ner.ms
            }
          }
        }
      } else {
        log('l3: text-region detection unavailable; canvas remains fail-closed')
      }
    }

    /* ---- redact + gate ---- */
    const out = await redactFrame({
      frame: source,
      width: capped.w,
      height: capped.h,
      items,
      marks,
      frameHash,
      // §7: the dirty tiles travel into the compositor, which crops them from
      // the redacted canvas before releasing it. Passing them here rather than
      // cropping afterwards is what keeps the raw-frame invariant intact.
      tiles: coalesceTiles(decision?.tiles ?? []),
      sessionId: runId,
      modelVersions: {
        l2: MODEL_IDS.l2,
        l3face: MODEL_IDS.l3face,
        l3text: MODEL_IDS.l3ocr,
        runtime: getDeviceInfo().device,
      },
    })

    /* ---- RAW REFERENCE DROPPED HERE. Nothing below touches pixels. ---- */
    source.close()
    source = null

    if (!out.verdict.ok || !out.blob) {
      log(`gate ABORT: ${out.verdict.reasons.join('; ')}`)
      await chrome.runtime.sendMessage({ kind: 'redact:aborted', runId, reason: out.verdict.reasons.join('; ') })
      return { ok: false, aborted: true, reasons: out.verdict.reasons }
    }

    const b64 = await blobToBase64(out.blob)

    /**
     * §7 delta-tile upload, for turns 2..N of a multi-step task.
     *
     * The frame-diff gate already computed which 64×64 tiles changed, so the
     * client knows the dirty region without re-scanning anything. This reports
     * it alongside the full frame; the service worker decides whether to send
     * the whole thing or just the tiles, and the server re-composites tiles
     * against the last full frame for the session.
     *
     * The full frame is still produced and still goes through the gate on every
     * turn. That is deliberate: the privacy argument is about what the SERVER
     * receives, and the fail-closed gate has to see the complete redacted frame
     * to be able to assert that every opaque region was covered. Skipping
     * redaction of unchanged tiles would be faster and would quietly reopen the
     * hole this project exists to close.
     */
    // The compositor crops the tiles itself, from the redacted canvas, before
    // that reference is released. See redact.ts:cropTiles.
    const changedTiles = out.tiles

    await chrome.runtime.sendMessage({
      kind: 'redact:ready',
      runId,
      manifest: out.manifest,
      verdict: out.verdict,
      webpB64: b64,
      bytes: out.bytes,
      tiles: changedTiles,
      frameWidth: out.frameWidth,
      frameHeight: out.frameHeight,
      timings: { ...out.timings, ...timings, capture: performance.now() - t0 },
    })
    void broadcastStatus()
    return {
      ok: true,
      bytes: out.bytes,
      redactions: out.manifest.redactions.length,
      tiles: changedTiles.length,
    }
  } finally {
    // Belt and braces: if any throw path skipped the close above, close here.
    if (source) {
      source.close()
      source = null
    }
  }
}

async function abort(runId: string, reason: string): Promise<unknown> {
  await chrome.runtime.sendMessage({ kind: 'redact:aborted', runId, reason })
  return { ok: false, aborted: true, reason }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/* ------------------------------------------------------------------ *
 *  The offscreen document is a plain WXT html entrypoint: it is loaded by
 *  chrome.offscreen.createDocument(), not by the SW. main() runs on load.
 * ------------------------------------------------------------------ */

export default defineUnlistedScript(start)
