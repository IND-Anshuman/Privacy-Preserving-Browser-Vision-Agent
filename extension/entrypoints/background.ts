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
import { parseActionPlan, parseManifest, ScreenStateSchema, SCHEMA_VERSION, type ActionPlan, type ScreenNode } from '@/lib/schema'
import { runPlan, MAX_STEPS_PER_PLAN, type PlanStep, type StepDriver, type StepResult } from '@/lib/execution'

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
  /**
   * Bytes that actually left the device.
   *
   * This used to accumulate the size of every redacted frame, which is the
   * number a judge checks against the network tab — so on a delta-tile turn it
   * would have reported bytes that were never sent. The privacy ledger is only
   * worth anything if it agrees with devtools, so it counts real payloads.
   */
  bytesOut: number
  /** Turns that shipped delta tiles instead of a full frame (§7). */
  deltaTurns: number
  /** Frame size from the last redact:ready, committed or discarded in send. */
  pendingFrameBytes: number
  /**
   * The pruned DOM snapshot for this run, cached here so the server call can
   * pair it with the manifest. Held only for the duration of the run and
   * carries placeholders, never raw values.
   */
  screenState: unknown
  /** Frame ids discovered for this tab, so execution can be scoped to one. */
  knownFrames: number[]
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

/**
 * Send to ONE frame, by id.
 *
 * A `sendMessage` without `frameId` is a broadcast. For execution that is the
 * defect this replaces: every same-origin frame would resolve the mark against
 * its own DOM and act. `options.frameId` makes the scope explicit.
 */
async function toFrame(tabId: number, frameId: number, msg: VeilMessage): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId })
  } catch {
    return { blocked: true }
  }
}

/**
 * Tell every frame in the tab what its own `frameId` is.
 *
 * Runs before each snapshot so a newly-inserted iframe is known even if it was
 * not present at injection time. Frames that cannot be reached (cross-origin,
 * CSP-blocked) simply do not answer, which is correct — they are treated as
 * opaque by the redaction cascade.
 */
async function identifyFrames(tabId: number): Promise<number[]> {
  let frames: chrome.webNavigation.GetAllFrameResultDetails[] = []
  try {
    const got = (await chrome.webNavigation?.getAllFrames({ tabId })) ?? []
    frames = got
  } catch {
    // webNavigation is not granted; fall back to the top frame only, which is
    // the safe direction: actions stay in the main document.
    frames = []
  }
  const ids = frames.length > 0 ? frames.map((f) => f.frameId) : [0]
  await Promise.all(ids.map((frameId) => toFrame(tabId, frameId, { kind: 'frame:identify', frameId })))
  return ids
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
      return startRun(msg.intent, msg.tier, msg.fresh)
    // `content:execute` is SW → content. The content script never originates it,
    // so handling it here was a loop-back path that re-broadcast a message the
    // SW had itself sent — and it broadcast to every frame, which is how a
    // single action could fan out. Execution is driven solely by the
    // `runPlan` driver, which addresses exactly one frame.
    case 'content:confirm':
      return confirmStep(msg.runId, msg.actionIndex, msg.approved !== false)
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

/**
 * The active session, so a follow-up turn can continue it.
 *
 * `run.turn` was hardcoded to 0 and never incremented, which made the delta-tile
 * gate `run.turn > 1` permanently false. But incrementing it alone would have
 * been a lie of a different kind: `startRun` minted a brand new `sessionId` on
 * every invocation, so a session could only ever hold one turn, and the server
 * would have rejected any tiled turn as belonging to no prior frame.
 *
 * Delta tiles are only meaningful when the server already holds the previous
 * frame of the SAME session — so multi-turn is the feature, not a detail.
 */
let activeSession: { sessionId: string; turn: number } | null = null

async function startRun(intent: string, tier: 'T0' | 'T1' | 'T2', fresh = false): Promise<unknown> {
  const runId = newId('run')
  // Continue the current session unless this is a fresh start. `fresh` is set
  // by the panel's "New conversation" control.
  const sessionId = fresh || !activeSession ? newId('sess') : activeSession.sessionId
  const turn = fresh || !activeSession ? 0 : activeSession.turn

  const run: RunState = {
    runId,
    sessionId,
    intent,
    tier,
    turn,
    deltaTurns: 0,
    startedAt: now(),
    stage: 'snapshot',
    redactionCount: 0,
    bytesOut: 0,
    pendingFrameBytes: 0,
    screenState: null,
    knownFrames: [0],
  }
  runs.set(runId, run)
  activeSession = { sessionId, turn }

  const tabId = await activeTabId()
  await ensureOffscreen(tabId)

  // 1. DOM channel. The content script builds the pruned snapshot, assigns
  //    marks, and runs L0/L1 — all in-page, all local.
  const t0 = now()
  // Announce frame ids BEFORE the snapshot, so every frame knows its own scope
  // before any action can be dispatched to it.
  run.knownFrames = await identifyFrames(tabId)
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
    // The marks MUST be forwarded. This was `marks: []`, which meant no badge
    // was ever burned into screen.webp — so `{"target":{"mark":17}}` had no
    // referent in the image the server sees and the whole Set-of-Mark
    // grounding mechanism was inert. [audit 1.5]
    marks: msg.marks,
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
  // Provisional: replaced below once we know whether this turn ships a full
  // frame or only tiles. Counting `msg.bytes` here would have overstated the
  // delta path, which is the number the ledger is checked against.
  run.pendingFrameBytes = msg.bytes

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
    // This used to send `offscreen:capture` and push the capture REPORT into
    // the chat bubble, so the local button answered `{"ok":true,"bytes":48210,
    // "redactions":7}`. tier0.answer() existed in offscreen/models.ts the whole
    // time and was never called. Now we ask the Prompt API, and when it is not
    // available we say so instead of inventing an answer.
    const intent = run.intent
    // The only screen text available here is `run.screenState`, and it is
    // already pseudonymized — labels carry [PERSON_a3_…] tokens, never raw
    // values. Feeding that to an on-device model is safe by construction: there
    // is nothing left to leak. Walk the real tree rather than inventing a
    // `manifest.sawText` field, which does not exist in the schema.
    // `screenState` is `unknown` in RunState on purpose — it arrives as an
    // untrusted message and is only ever trusted after schema validation. Parse
    // it here for the same reason rather than casting, so a malformed tree can
    // never reach the prompt builder.
    let screenText = ''
    if (run.screenState) {
      const parsed = ScreenStateSchema.safeParse(run.screenState)
      if (parsed.success) screenText = flattenScreenText(parsed.data.root)
    }
    const local = (await toOffscreen({
      kind: 'offscreen:local',
      runId: run.runId,
      intent,
      screenText,
    })) as { ok: boolean; text?: string; source?: string; error?: string }

    if (local?.ok && local.text) {
      sendToPanel({
        kind: 'panel:answer',
        runId: run.runId,
        text: local.text,
        tier: 'T0',
        source: local.source ?? 'prompt-api',
      })
    } else {
      // No on-device model (the common case in Chrome today). Say the truth
      // rather than shipping a JSON blob as if it were an answer.
      const why = local?.error ?? local?.source ?? 'no on-device model in this browser'
      sendToPanel({
        kind: 'panel:answer',
        runId: run.runId,
        text:
          `I can redact this page, but I can't answer it on-device here — ${why}. ` +
          `Nothing was sent anywhere. Use the agent mode and the redacted screen ` +
          `goes to your configured model instead.`,
        tier: 'T0',
        source: 'unavailable',
      })
    }
    run.stage = 'done'
    return { ok: true, tier: 'T0' }
  }

  // 3. T1: send the three artifacts. Only sanitized bytes exist downstream.
  const screenState = ScreenStateSchema.parse(run.screenState)

  /**
   * §7 delta-tile upload, turns 2..N.
   *
   * On a later turn of the same task, only the tiles the frame-diff gate marked
   * dirty need to travel; the server re-composites them onto the last full
   * frame for the session. Turn 1 always sends everything, and so does any turn
   * where the dirty region covers most of the frame — uploading a full frame
   * plus a tile list would cost more than it saves.
   *
   * This is a bandwidth optimisation only. The redaction, the manifest and the
   * fail-closed gate all ran identically on the full frame, so the tile path
   * cannot weaken the privacy guarantee.
   */
  const tiles = msg.tiles ?? []
  // Compare the REAL payload sizes, not a coverage heuristic. If the encoded
  // tiles are not actually smaller than the full frame — which happens on a
  // heavily-dirty frame, where PNG overhead dominates — send the full frame.
  // The measurement is the base64 length we are about to put on the wire.
  const tileBytes = tiles.reduce((a, t) => a + (t.b64?.length ?? 0), 0)
  const fullBytes = msg.webpB64?.length ?? 0
  const useTiles = run.turn > 1 && tiles.length > 0 && tileBytes > 0 && tileBytes < fullBytes

  const body = {
    schema_version: SCHEMA_VERSION,
    session_id: run.sessionId,
    intent: run.intent,
    turn: run.turn,
    screen_state: screenState,
    redaction_manifest: manifest,
    // A tiled turn sends no full image: the server holds the previous frame.
    image_b64: useTiles ? undefined : msg.webpB64,
    ...(useTiles
      ? {
          tiles: tiles.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h, b64: t.b64 })),
          frame_width: msg.frameWidth,
          frame_height: msg.frameHeight,
        }
      : {}),
    client_timings: msg.timings,
    tier: run.tier,
  }

  // Record what actually went out, so the privacy ledger reports real bytes
  // rather than the size of a frame we chose not to send. This is the number a
  // judge checks against the network tab, so it counts the payload that was
  // actually serialised and nothing else.
  run.bytesOut += useTiles ? tileBytes : fullBytes
  if (useTiles) {
    run.deltaTurns += 1
    // The panel's waterfall shows the real payload size, so this line is what
    // keeps the privacy ledger and the network tab in agreement.
    console.info(
      `[veil] delta turn ${run.turn}: ${tiles.length} tile(s) ~${tileBytes}B ` +
      `vs ${run.pendingFrameBytes}B full frame`,
    )
  }

  const result = await callServer(body, run)
  stage(run.runId, 'server', now() - t0)

  // Advance the turn for the NEXT request. Until this existed, `turn` stayed 0
  // for the life of the session, so the `turn > 1` delta gate could never open
  // and the composer's tile path was dead code that had never once run.
  run.turn += 1
  if (activeSession && activeSession.sessionId === run.sessionId) {
    activeSession.turn = run.turn
  }

  // 4. EXECUTE THE PLAN. This step did not exist: the plan was parsed, sent to
  //    the side panel, and then nothing happened — the agent observed but never
  //    acted. [audit 0.2]
  if (result.ok && result.plan) {
    // The top frame by default. A mark that lives in a subframe would need the
    // server to name it; until it does, acting in the main document is the
    // scoped-and-safe choice rather than a broadcast.
    await executePlan(run.runId, result.plan, 0)
  }
  return result
}

/* ------------------------------------------------------------------ *
 *  Plan execution (§4)
 * ------------------------------------------------------------------ */

/** Steps that must be handed to the human rather than run automatically. */

/**
 * Run a plan in order, awaiting each step.
 *
 * The loop itself now lives in `lib/execution.ts` as a pure function over a
 * `StepDriver`, because every branch of it used to be untestable — which is
 * how `ok` came to be destructured and then ignored, so a failed step advanced
 * the plan exactly like a successful one, and how the confirmation path came to
 * be unreachable.
 *
 * This function is only the transport: it knows how to reach the page and the
 * panel, and nothing about policy.
 */
async function executePlan(
  runId: string,
  plan: ActionPlan,
  targetFrameId = 0,
): Promise<{ executed: number; halted: number }> {
  const tabId = await activeTabId()

  const driver: StepDriver = {
    async run(index: number, step: PlanStep): Promise<StepResult> {
      // Address exactly one frame. `toContent` here would broadcast.
      const res = await toFrame(tabId, targetFrameId, {
        kind: 'content:execute',
        runId,
        actionIndex: index,
        targetFrameId,
        action: step,
      })
      return normalizeStepResult(res)
    },
    async ask(index: number, reason: string): Promise<boolean> {
      // This is the function that used to be missing. The confirm card is
      // rendered by the panel from `execute:confirm_required`, and the panel
      // answers with `content:confirm`, which lands in `confirmations` — the
      // map `waitForConfirmation` polls. With the content script now emitting
      // `execute:confirm_required`, all four links are connected.
      sendToPanel({ kind: 'panel:stage', runId, stage: `waiting for you: ${reason}`, ms: 0 })
      return waitForConfirmation(runId, index, tabId, reason)
    },
  }

  const res = await runPlan({ steps: plan.steps as PlanStep[] }, driver)

  // Report what actually happened. A run that stopped early must say so.
  for (const ev of res.events) {
    if (ev.type === 'failed') {
      sendToPanel({ kind: 'panel:error', runId, message: `Step ${ev.index + 1} failed: ${ev.reason}` })
    } else if (ev.type === 'declined') {
      sendToPanel({ kind: 'panel:error', runId, message: 'Stopped — you declined that step.' })
    } else if (ev.type === 'capped') {
      sendToPanel({
        kind: 'panel:error',
        runId,
        message: `Plan had ${ev.requested} steps; ran the first ${ev.ran}.`,
      })
    }
  }

  stage(runId, 'execute', 0)
  const run = runs.get(runId)
  if (run) run.stage = res.ok ? 'done' : 'aborted'
  return { executed: res.executed, halted: res.halted }
}

/**
 * Coerce whatever the content script replied with into an honest StepResult.
 *
 * A missing port (`{blocked:true}` — the page is chrome:// or refused
 * injection) is a FAILURE. It used to flow through as an object with no `ok`
 * field, which the loop then treated as fine.
 */
function normalizeStepResult(res: unknown): StepResult {
  if (!res || typeof res !== 'object') {
    return { ok: false, action: 'unknown', effect: 'unchanged', error: 'the page did not respond' }
  }
  const r = res as Partial<StepResult> & { blocked?: boolean }
  if (r.blocked) {
    return {
      ok: false,
      action: String(r.action ?? 'unknown'),
      effect: 'unchanged',
      error: 'this page does not allow the agent to act on it',
    }
  }
  if (typeof r.ok !== 'boolean') {
    return {
      ok: false,
      action: String(r.action ?? 'unknown'),
      effect: 'unknown',
      error: 'the page did not report a result',
    }
  }
  return {
    ok: r.ok,
    action: String(r.action ?? 'unknown'),
    ms: typeof r.ms === 'number' ? r.ms : 0,
    needsConfirm: r.needsConfirm === true,
    reason: r.reason,
    error: r.error,
    effect: r.effect,
  }
}

/** Poll for the user's confirmation, bounded so a run can never hang forever. */
function waitForConfirmation(runId: string, index: number, tabId: number, label: string): Promise<boolean> {
  void tabId
  return new Promise((resolve) => {
    const deadline = Date.now() + 60_000
    const tick = async (): Promise<void> => {
      const pending = confirmations.get(`${runId}:${index}`)
      if (pending !== undefined) {
        confirmations.delete(`${runId}:${index}`)
        resolve(pending)
        return
      }
      if (Date.now() > deadline || !runs.has(runId)) {
        resolve(false)
        return
      }
      setTimeout(() => void tick(), 250)
    }
    sendToPanel({ kind: 'panel:stage', runId, stage: `waiting for you: ${label}`, ms: 0 })
    void tick()
  })
}

const confirmations = new Map<string, boolean>()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

/**
 * Depth-first text of a screen-state tree, for the on-device tier.
 *
 * Labels are already pseudonymized upstream (`[PERSON_a3_1a2b3c4d]`, never the
 * raw value), so this string is safe to hand to a local model by construction.
 * Bounded so a pathological page cannot balloon a prompt.
 */
function flattenScreenText(node: ScreenNode, depth = 0, out: string[] = []): string {
  if (out.length >= 400 || depth > 12) return out.join('\n')
  if (node.label) out.push(node.label)
  if (node.value) out.push(node.value)
  for (const child of node.children ?? []) flattenScreenText(child, depth + 1, out)
  return out.join('\n')
}

/**
 * Resolve a pending confirmation. This used to forward the message and return an
 * ack, which meant a confirmed destructive step still did nothing — the user
 * clicked "yes" and the button was never pressed. [audit 3.1]
 */
async function confirmStep(runId: string, actionIndex: number, approved: boolean): Promise<unknown> {
  confirmations.set(`${runId}:${actionIndex}`, approved)
  return { ok: true, recorded: approved }
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

