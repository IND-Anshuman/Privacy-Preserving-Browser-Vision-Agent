/**
 * Background service worker — orchestration ONLY. ARCHITECTURE.md §2.
 *
 * Hard rule for this file: no heavy compute, no model, no canvas, no large
 * buffers. MV3 kills service workers aggressively; anything precious living
 * here is state that will be lost. The worker routes intent, sequences
 * capture → redact → send → execute, and owns the run state machine.
 *
 * The only thing that ever sees raw pixels is the offscreen document, and even
 * there the frame is nulled after compositing (§6.3).
 */
import { defineBackground } from 'wxt/sandbox'
import type { Msg, VeilMessage } from '@/lib/messages'
import { parseMessage } from '@/lib/messages'
import { parseActionPlan, parseManifest, ScreenStateSchema, SCHEMA_VERSION, type ActionPlan } from '@/lib/schema'

/* ------------------------------------------------------------------ *
 *  Run state. Deliberately small and serializable — it is the ONLY
 *  state the SW keeps, and it holds no page content.
 * ------------------------------------------------------------------ */

interface RunState {
  runId: string
  sessionId: string
  intent: string
  tier: 'T0' | 'T1' | 'T2'
  turn: number
  startedAt: number
  /** Which stage of the pipeline we are in. */
  stage: 'snapshot' | 'redact' | 'send' | 'execute' | 'done' | 'aborted'
  redactionCount: number
  bytesOut: number
  /**
   * The pruned DOM snapshot for this run, cached here so the server call can
   * pair it with the manifest. Held only for the duration of the run and
   * carries placeholders, never raw values.
   */
  screenState: unknown
}

const runs = new Map<string, RunState>()
const SERVER_DEFAULT = 'http://127.0.0.1:8000'

let serverOrigin = SERVER_DEFAULT
let offscreenReady = false

/* ------------------------------------------------------------------ *
 *  Server origin is configurable, but it is the ONLY origin the
 *  extension is permitted to talk to. Stored, never discovered.
 * ------------------------------------------------------------------ */

async function loadConfig(): Promise<void> {
  const got = await chrome.storage.local.get(['serverOrigin'])
  const v = got['serverOrigin']
  if (typeof v === 'string' && /^https?:\/\//.test(v)) serverOrigin = v.replace(/\/$/, '')
}

/* ------------------------------------------------------------------ *
 *  Startup. WXT imports this module in Node during `prepare`, so every
 *  chrome.* call is inside main() — never at module scope. [verified by the
 *  `MutationObserver is not defined` failure this structure is fixing]
 * ------------------------------------------------------------------ */

function start(): void {
  chrome.runtime.onInstalled.addListener(() => {
    void loadConfig()
    void chrome.storage.local.get(['serverOrigin']).then((g) => {
      if (!g['serverOrigin']) void chrome.storage.local.set({ serverOrigin: SERVER_DEFAULT })
    })
  })
  chrome.runtime.onStartup.addListener(() => void loadConfig())
  void loadConfig()

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = parseMessage(raw)
    if (!msg) {
      // Unknown or malformed message: drop it. Never act on unvalidated input.
      sendResponse({ ok: false, error: 'invalid message' })
      return false
    }
    void handle(msg).then(sendResponse).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      const runId = 'runId' in msg && typeof msg.runId === 'string' ? msg.runId : 'unknown'
      const run = runs.get(runId)
      if (run && run.stage !== 'aborted') run.stage = 'aborted'
      sendToPanel({ kind: 'panel:error', runId, message })
      sendResponse({ ok: false, error: message })
    })
    return true // async response
  })

  if (chrome.sidePanel?.setPanelBehavior) {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)
  }
}

export type { RunState, Msg }

export default defineBackground({ type: 'module', main: start })

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

const now = () => performance.now()
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function sendToPanel(msg: VeilMessage): void {
  void chrome.runtime.sendMessage(msg).catch(() => {
    // The panel may not be open. Swallowing this is correct: a missing
    // panel must never fail a run.
  })
}

function stage(runId: string, name: string, ms: number): void {
  sendToPanel({ kind: 'panel:stage', runId, stage: name, ms })
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('no active tab')
  return tab.id
}

/* ------------------------------------------------------------------ *
 *  Offscreen document lifecycle [ARCHITECTURE §2]
 * ------------------------------------------------------------------ */

const OFFSCREEN_PATH = 'offscreen.html'

async function ensureOffscreen(tabId: number): Promise<void> {
  if (offscreenReady && (await hasOffscreen())) return

  // Firefox has no chrome.offscreen API. There the content script posts the
  // capture to the background page via runtimePort and the panel, or a plain
  // MV3 background page, does the compositing. This is the one place the two
  // browsers genuinely diverge and it is feature-detected, never assumed.
  if (!hasOffscreenApi()) {
    offscreenReady = false
    return
  }

  const existing = await hasOffscreen()
  if (existing) {
    offscreenReady = true
    return
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [
      'WORKERS' as chrome.offscreen.Reason, // model sessions live here
      'DISPLAY_MEDIA' as chrome.offscreen.Reason, // tabCapture stream
      'BLOBS' as chrome.offscreen.Reason, // convertToBlob encoding
    ],
    justification:
      'Veil composites the redacted frame on an OffscreenCanvas and runs the local PII detectors. The service worker has no DOM and no WebGPU.',
  })
  offscreenReady = true
  void tabId
}

function hasOffscreenApi(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.offscreen?.createDocument === 'function'
}

async function hasOffscreen(): Promise<boolean> {
  if (!hasOffscreenApi()) return false
  if (typeof chrome.runtime.getContexts === 'function') {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
    return ctx.length > 0
  }
  return false // older Chrome: creating twice throws, so we always create fresh
}

/* ------------------------------------------------------------------ *
 *  Message plumbing
 * ------------------------------------------------------------------ */

async function toContent(tabId: number, msg: VeilMessage): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg)
  } catch {
    // Content script not injected (chrome:// page, or a page that blocked it).
    // Fail-closed: we do NOT fall back to "send anyway" (§6.3). The pixel-only
    // tier still applies, but only after the gate has run.
    return { blocked: true }
  }
}

async function toOffscreen(msg: VeilMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(msg)
}


/* ------------------------------------------------------------------ *
 *  The run pipeline
 * ------------------------------------------------------------------ */

async function handle(msg: VeilMessage): Promise<unknown> {
  switch (msg.kind) {
    case 'panel:run':
      return startRun(msg.intent, msg.tier)
    case 'content:execute':
      return executeStep(msg.runId, msg.action)
    case 'content:confirm':
      return confirmStep(msg.runId, msg.actionIndex)
    case 'snapshot:ready':
      return onSnapshotReady(msg)
    case 'redact:ready':
      return onRedactReady(msg)
    case 'redact:aborted':
      return onRedactAborted(msg)
    case 'execute:done':
    case 'execute:confirm_required':
    case 'frame:crossorigin':
      return onContentReport(msg)
    case 'offscreen:status':
      // The HUD subscribes directly to the offscreen document's status
      // broadcast; nothing to relay from the SW.
      return { ok: true }
    default:
      return { ok: false, error: `unhandled ${msg.kind}` }
  }
}

async function startRun(intent: string, tier: 'T0' | 'T1' | 'T2'): Promise<unknown> {
  const runId = newId('run')
  const sessionId = newId('sess')
  const run: RunState = {
    runId,
    sessionId,
    intent,
    tier,
    turn: 0,
    startedAt: now(),
    stage: 'snapshot',
    redactionCount: 0,
    bytesOut: 0,
    screenState: null,
  }
  runs.set(runId, run)

  const tabId = await activeTabId()
  await ensureOffscreen(tabId)

  // 1. DOM channel. The content script builds the pruned snapshot, assigns
  //    marks, and runs L0/L1 — all in-page, all local.
  const t0 = now()
  await toContent(tabId, { kind: 'content:snapshot', runId })
  stage(runId, 'snapshot', now() - t0)

  return { ok: true, runId, sessionId }
}

/**
 * Content script finished the DOM channel. Cache the snapshot on the run and
 * hand the L0/L1 boxes to the offscreen document for the pixel channel.
 */
async function onSnapshotReady(msg: Extract<VeilMessage, { kind: 'snapshot:ready' }>): Promise<unknown> {
  const run = runs.get(msg.runId)
  if (!run) return { ok: false, error: 'unknown run' }

  // Parse on arrival. A malformed snapshot must never reach the server.
  run.screenState = ScreenStateSchema.parse(msg.screenState)

  run.stage = 'redact'
  const t0 = now()
  const res = await toOffscreen({
    kind: 'offscreen:capture',
    runId: run.runId,
    mode: 'auto',
    boxes: msg.rawDetections,
    marks: [],
  })
  stage(run.runId, 'capture+redact', now() - t0)
  return res
}

async function onRedactReady(msg: Extract<VeilMessage, { kind: 'redact:ready' }>): Promise<unknown> {
  const run = runs.get(msg.runId)
  if (!run) return { ok: false, error: 'unknown run' }

  // Parse the manifest even though we mostly pass it through: if the offscreen
  // document produced a malformed manifest, we refuse to send. Fail-closed.
  const manifest = parseManifest(msg.manifest)
  run.redactionCount = manifest.redactions.length
  run.bytesOut += msg.bytes

  if (manifest.abort_reason) {
    run.stage = 'aborted'
    return { ok: false, error: `gate aborted: ${manifest.abort_reason}` }
  }

  if (!run.screenState) {
    run.stage = 'aborted'
    return { ok: false, error: 'no screen state: snapshot stage did not complete' }
  }

  run.stage = 'send'
  const t0 = now()

  // 2. Tier-0 short circuit: a known local intent needs no network at all.
  if (run.tier === 'T0') {
    const answer = await toOffscreen({ kind: 'offscreen:capture', runId: run.runId, mode: 'auto', boxes: [], marks: [] })
    sendToPanel({ kind: 'panel:answer', runId: run.runId, text: String(answer ?? ''), tier: 'T0' })
    run.stage = 'done'
    return { ok: true, tier: 'T0' }
  }

  // 3. T1: send the three artifacts. Only sanitized bytes exist downstream.
  const screenState = ScreenStateSchema.parse(run.screenState)

  const body = {
    schema_version: SCHEMA_VERSION,
    session_id: run.sessionId,
    intent: run.intent,
    turn: run.turn,
    screen_state: screenState,
    redaction_manifest: manifest,
    image_b64: msg.webpB64,
    client_timings: msg.timings,
    tier: run.tier,
  }

  const plan = await callServer(body, run)
  stage(run.runId, 'server', now() - t0)
  return plan
}

async function onRedactAborted(msg: Extract<VeilMessage, { kind: 'redact:aborted' }>): Promise<unknown> {
  const run = runs.get(msg.runId)
  if (!run) return { ok: false, error: 'unknown run' }
  run.stage = 'aborted'
  // Ledger entry with 0 bytes out: the whole point of the fail-closed gate.
  sendToPanel({
    kind: 'panel:ledger',
    runId: run.runId,
    entries: [
      {
        t: Date.now(),
        runId: run.runId,
        label: `aborted: ${msg.reason}`,
        bytesOut: 0,
        bytesIn: 0,
        redactions: 0,
        placeholders: [],
        tier: run.tier,
        frameHash: '',
        durationMs: now() - run.startedAt,
      },
    ],
  })
  sendToPanel({ kind: 'panel:error', runId: run.runId, message: `Request aborted: ${msg.reason}` })
  return { ok: false, aborted: true, reason: msg.reason }
}

async function callServer(
  body: unknown,
  run: RunState,
): Promise<{ ok: boolean; plan?: ActionPlan; error?: string }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(`${serverOrigin}/v1/agent/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, error: `server ${res.status}` }
    const text = await res.text()
    const plan = parseActionPlan(JSON.parse(text))
    run.stage = 'execute'
    sendToPanel({ kind: 'panel:plan', runId: run.runId, plan })
    return { ok: true, plan }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' }
  } finally {
    clearTimeout(t)
  }
}

async function executeStep(runId: string, action: unknown): Promise<unknown> {
  const tabId = await activeTabId()
  return toContent(tabId, { kind: 'content:execute', runId, action })
}

async function confirmStep(runId: string, actionIndex: number): Promise<unknown> {
  const tabId = await activeTabId()
  return toContent(tabId, { kind: 'content:confirm', runId, actionIndex, label: 'confirm' })
}

async function onContentReport(msg: VeilMessage): Promise<unknown> {
  if (msg.kind === 'frame:crossorigin') {
    // A frame refused injection → treated as fully sensitive (§5). The content
    // script already marks it; the gate will refuse to emit if uncovered.
    return { ok: true }
  }
  if (msg.kind === 'execute:done') {
    stage(msg.runId, 'execute', msg.ms)
    return { ok: true }
  }
  return { ok: true }
}

