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
import { runPlan, MAX_STEPS_PER_PLAN, type PlanStep, type PlanRunResult, type StepDriver, type StepResult } from '@/lib/execution'
import { parsePlanStream } from '@/lib/sse'
import { LogRing, createLogger, persistRing, restoreRing, type LogChannel } from '@/lib/logging'
import { newWatchdog, describeRunError, DEFAULT_RUN_TIMEOUT_MS, isTerminalStage, StageDeadline } from '@/lib/watchdog'
import { isBlockedResult, snapshotFailure } from '@/lib/pipe'

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

/**
 * A log that outlives the worker that wrote it.
 *
 * The console is not enough here, and that is the whole point: the most
 * common failure in this extension is the MV3 worker being TERMINATED
 * MID-RUN, which takes the console buffer with it. A user reporting "nothing
 * appears in the console" was reporting this correctly — there was nothing to
 * see, because the thing that would have logged had been killed.
 *
 * So entries go into a bounded ring and are mirrored into
 * chrome.storage.session, which outlives the worker. The panel reads them
 * back. `console.*` still gets every line, for a developer with devtools open.
 */
const logRing = new LogRing()
const log = createLogger(logRing)

/** Persist after every batch of lines, not on a timer. */
function flushLog(): void {
  void persistRing(logRing)
}

const watchdog = newWatchdog({
  // A rewind is a call-ordering bug. Log it rather than silently swallowing it,
  // because the symptom (a stall named after a finished stage) is otherwise
  // indistinguishable from a real hang.
  onRewind: (runId, from, to) => {
    log('sw', `run ${runId} stage went backwards: ${from} -> ${to} (ignored)`, 'warn')
    flushLog()
  },
  // NO `timeoutMs` HERE, AND THAT IS THE POINT.
  //
  // It used to pass `DEFAULT_RUN_TIMEOUT_MS` (45s), and arm() resolves the
  // budget as `opts.timeoutMs ?? stageTimeoutMs(stage)` — so the override
  // always won and the entire STAGE_TIMEOUT_MS table was dead code in
  // production. Every stage got a flat 45s, which is exactly the behaviour
  // the table was added to fix: the trace showed a run stalling in "snapshot"
  // while it was really waiting on a ~13-19s network turn.
  //
  // A passing test suite did not catch it because the table tests construct
  // their own RunWatchdog without the override. The wiring was never tested.
  onExpire: (stalled) => {
    // The run object is gone (that is WHY we are here), so this cannot mark
    // it aborted. It only has to make sure the panel is told.
    log('sw', `run ${stalled.runId} stalled in "${stalled.stage}" after ${Math.round(stalled.elapsedMs / 1000)}s`, 'error')
    sendToPanel({ kind: 'panel:error', runId: stalled.runId, message: describeRunError(stalled) })
    flushLog()
  },
})
const SERVER_DEFAULT = 'http://127.0.0.1:8000'

/**
 * Server timeout, from a measurement rather than a round number.
 *
 * `bench/compare_models.py` measured the configured model at p50 15.7s and
 * p95 24.8s. The previous hardcoded 20s therefore aborted a MAJORITY of real
 * turns mid-plan and surfaced as a bare "network error" — indistinguishable
 * from the server being down. The default is the measured p95 plus a margin,
 * and a user on a different model can raise it in the panel's settings.
 */
const SERVER_TIMEOUT_DEFAULT_MS = 45_000
let serverTimeoutOverrideMs: number | null = null

function serverTimeoutMs(): number {
  return serverTimeoutOverrideMs ?? SERVER_TIMEOUT_DEFAULT_MS
}

let serverOrigin = SERVER_DEFAULT
let offscreenReady = false

/* ------------------------------------------------------------------ *
 *  Server origin is configurable, but it is the ONLY origin the
 *  extension is permitted to talk to. Stored, never discovered.
 * ------------------------------------------------------------------ */

async function loadConfig(): Promise<void> {
  const got = await chrome.storage.local.get(['serverOrigin', 'serverTimeoutMs'])
  const v = got['serverOrigin']
  if (typeof v === 'string' && /^https?:\/\//.test(v)) serverOrigin = v.replace(/\/$/, '')
  // The server's own budget is VEIL_LLM_TIMEOUT_S (default 90s). The client must
  // not be the tighter of the two, or it aborts a turn the server was still
  // legitimately planning.
  const t = got['serverTimeoutMs']
  if (typeof t === 'number' && t >= 5_000 && t <= 600_000) serverTimeoutOverrideMs = t
}

/* ------------------------------------------------------------------ *
 *  Startup. WXT imports this module in Node during `prepare`, so every
 *  chrome.* call is inside main() — never at module scope. [verified by the
 *  `MutationObserver is not defined` failure this structure is fixing]
 * ------------------------------------------------------------------ */

function start(): void {
  // A fresh worker after a restart is the single most confusing thing a user
  // can hit, so say so. Without this line the console looks empty precisely
  // when something went wrong, which is backwards.
  void (async () => {
    await restoreRing(logRing)
    log('sw', 'background worker started' + (runs.size ? '' : ' (no run in progress — the previous worker was recycled)'), 'info')
    flushLog()
  })()

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
      log('sw', `run ${runId} failed in "${run?.stage ?? 'unknown'}": ${message}`, 'error')
      flushLog()
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
  // A terminal message is the ONLY thing that un-sticks the panel, so ending a
  // run is the one place the watchdog must always be stopped.
  if (msg.kind === 'panel:error' || msg.kind === 'panel:plan' || msg.kind === 'panel:answer') {
    watchdog.finish(msg.runId)
    stageDeadline.end(msg.runId)
  }
  void chrome.runtime.sendMessage(msg).catch(() => {
    // The panel may not be open. Swallowing this is correct: a missing
    // panel must never fail a run.
  })
}

const stageDeadline = new StageDeadline()

/** The DOM channel produced nothing. Named apart from the run watchdog so the
 *  user is told about the page read, not about the browser. */
function onStageTimeout(runId: string, stageName: string): void {
  const run = runs.get(runId)
  if (run && isTerminalStage(run.stage)) return
  const where = stageName === 'snapshot' ? 'reading the page' : 'in the redaction step'
  const message =
    `Veil stopped ${where}: the page never finished being read, and nothing was sent. ` +
    // Do not guess. The previous version of this message asserted "the page
    // may be very large, or a script on it may be blocking the page's own
    // handlers" — and fired that claim on runs where the page had been read
    // successfully in 37ms.
    `A page that stops responding to its own scripts, or a very large one, ` +
    `can both cause this. Press Reload, and if it repeats on the same page, ` +
    `open the Activity log — it will show the last stage that completed.`
  log('sw', `run ${runId} stage ${stageName} timed out`, 'error')
  flushLog()
  sendToPanel({ kind: 'panel:error', runId, message })
}

function stage(runId: string, name: string, ms: number): void {
  if (isTerminalStage(name)) watchdog.finish(runId)
  else watchdog.begin(runId, name)
  log('sw', `${name} ${ms.toFixed(0)}ms`, 'info')
  sendToPanel({ kind: 'panel:stage', runId, stage: name, ms })
  flushLog()
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
  watchdog.begin(runId, 'snapshot')
  log('sw', `run ${runId} start tier=${tier} session=${sessionId} turn=${turn} intent="${intent.slice(0, 80)}"`, 'info')

  const tabId = await activeTabId()
  await ensureOffscreen(tabId)

  // 1. DOM channel. The content script builds the pruned snapshot, assigns
  //    marks, and runs L0/L1 — all in-page, all local.
  const t0 = now()
  // Announce frame ids BEFORE the snapshot, so every frame knows its own scope
  // before any action can be dispatched to it.
  run.knownFrames = await identifyFrames(tabId)

  // ARM BEFORE THE AWAIT. This ordering is the fix.
  //
  // The content script handles `content:snapshot` by AWAITING its own
  // `chrome.runtime.sendMessage({kind:'snapshot:ready'})` and only then
  // returning `{ok:true}`. So `snapshot:ready` is handled *inside* the
  // `await toContent(...)` below — before the next line of this function runs.
  //
  // Arming afterwards (as this did) meant `onSnapshotReady`'s `end()` ran
  // against a timer that did not exist yet, so it settled nothing, and the 8s
  // deadline was then armed with no event left to clear it. It fired 8s later
  // on a healthy run that had already reached the network turn, and the message
  // blamed a very large page and blocking scripts. Neither was true.
  stageDeadline.begin(runId, 'snapshot', STAGE_SNAPSHOT_MS, (st: string) => onStageTimeout(runId, st))

  const snap = await toContent(tabId, { kind: 'content:snapshot', runId })

  // Report the timing, but DO NOT REWIND THE WATCHDOG.
  //
  // The whole onSnapshotReady handler runs INSIDE the await above, because the
  // content script awaits its own `snapshot:ready` before returning. So by the
  // time we get here the pipeline may already be at 'capture+redact' or
  // 'send'. Calling stage(runId,'snapshot',...) at this point moved the
  // watchdog BACKWARDS to a stage that had already finished, which is how a
  // run stalled in "snapshot" 45s after the snapshot had completed in 44ms —
  // the trace showed `capture+redact 2ms` printed BEFORE `snapshot 44ms`.
  //
  // The timing line is still worth printing; only the re-arm is wrong.
  const snapMs = now() - t0
  log('sw', `snapshot ${snapMs.toFixed(0)}ms`, 'info')
  flushLog()
  sendToPanel({ kind: 'panel:stage', runId, stage: 'snapshot', ms: snapMs })

  // `toContent` returns `{blocked:true}` when there is no content script on
  // the tab, and this used to be ignored — so the run reported a 2ms
  // successful snapshot and then sat waiting for a `snapshot:ready` that could
  // never arrive, until the 45s watchdog reported the stall. The cause was
  // knowable synchronously; the user waited 45s to be told it.
  //
  // A blocked snapshot is a hard stop, not a fallback: sending a frame we
  // could not read would mean sending pixels we never redacted.
  if (isBlockedResult(snap)) {
    let url: string | undefined
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      url = tab?.url
    } catch {
      /* the tab is gone; the message below still stands */
    }
    const { reason, message } = snapshotFailure(url)
    stageDeadline.end(runId)
    run.stage = 'aborted'
    watchdog.finish(runId)
    log('sw', `run ${runId} snapshot blocked (${reason}) url=${(url ?? '').slice(0, 60)}`, 'error')
    flushLog()
    sendToPanel({ kind: 'panel:error', runId, message })
    return { ok: false, error: message, reason }
  }

  // Settle the deadline on every path out of here.
  //
  // If the content script sent `snapshot:ready` inside the await above, it was
  // already handled and already settled this. If it did not, settling here is
  // still correct: the DOM channel is done, so the deadline has nothing left to
  // watch. Either way nothing is left armed into the network turn.
  stageDeadline.end(runId)

  return { ok: true, runId, sessionId }
}

/**
 * A per-stage deadline, separate from the run watchdog.
 *
 * A run watchdog has to allow for the slow stage — the network turn measures
 * p50 ~13s and p95 ~19s. That budget is wildly wrong for the DOM snapshot,
 * which is a local walk of the page. One shared deadline means either the
 * snapshot hangs for 45 seconds waiting to be called slow, or it is given so
 * little time that a big page fails falsely. So the stages are budgeted apart.
 */
const STAGE_SNAPSHOT_MS = 8_000

/**
 * Content script finished the DOM channel. Cache the snapshot on the run and
 * hand the L0/L1 boxes to the offscreen document for the pixel channel.
 */
async function onSnapshotReady(msg: Extract<VeilMessage, { kind: 'snapshot:ready' }>): Promise<unknown> {
  const run = runs.get(msg.runId)
  if (!run) return { ok: false, error: 'unknown run' }

  // Parse on arrival. A malformed snapshot must never reach the server.
  stageDeadline.end(msg.runId)
  run.screenState = ScreenStateSchema.parse(msg.screenState)

  const t0 = now()
  log('sw', `run ${msg.runId} snapshot: ${msg.marks.length} marks, ${msg.rawDetections.length} L0/L1 hits, opaque=${msg.opaqueFrames?.length ?? 0}`, 'info')
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

  // `runCapture` answers `{ok:false, aborted:true}` when the redaction gate
    // could not verify coverage, and `toOffscreen` has no try/catch, so a
    // missing offscreen document THROWS. It can also answer `{ok:true, skipped:true}`
    // when the frame-diff gate reports "unchanged" — a valid result that used to
    // be dropped, leaving the run stuck in 'capture+redact' until the watchdog
    // fired at 15s. Either way the return value used to be dropped on the floor.
    if (isBlockedResult(res) || (res as { ok?: boolean })?.ok === false) {
      const reason =
        (res as { reason?: string; error?: string })?.reason ??
        (res as { error?: string })?.error ??
        'the redaction step did not complete'
      run.stage = 'aborted'
      watchdog.finish(msg.runId)
      log('sw', `run ${msg.runId} capture/redact failed: ${reason}`, 'error')
      flushLog()
      sendToPanel({
        kind: 'panel:error',
        runId: msg.runId,
        message:
          `Veil stopped at the redaction step, so nothing was sent. (${reason}) ` +
          `A frame that cannot be verified is never sent — that is the point of the gate.`,
      })
      return { ok: false, error: reason }
    }

    // A 'skipped' result means the frame-diff gate found no changes. The page is
    // static, so there is nothing new to send to the model — but the run must
    // still advance and finish rather than sitting in 'capture+redact' forever.
    if ((res as { skipped?: boolean })?.skipped) {
      // For T0 we answer locally. For T1 we would send, but sending a duplicate
      // frame when nothing changed is pointless — so we finish the run locally
      // with an honest answer instead of asking the model about the same pixels.
      if (run.tier === 'T0') {
        // The local answer path is handled by onRedactReady, but we never reach it
        // because the offscreen document short-circuits. So we synthesize the
        // local answer here. The prompt API path still works for a new question
        // on a static page; this is only about not re-sending unchanged pixels.
        const screenText = run.screenState
          ? flattenScreenText(ScreenStateSchema.parse(run.screenState).root)
          : ''
        const local = (await toOffscreen({
                  kind: 'offscreen:local',
                  runId: msg.runId,
                  intent: run.intent,
                  screenText,
                })) as { ok: boolean; text?: string; source?: string; error?: string }

                if (local?.ok && local.text) {
                  sendToPanel({ kind: 'panel:answer', runId: msg.runId, text: local.text, tier: 'T0', source: local.source ?? 'prompt-api' })
                } else {
                  const why = local?.error ?? local?.source ?? 'no on-device model in this browser'
                  sendToPanel({
                    kind: 'panel:answer',
                    runId: msg.runId,
                    text: `Nothing changed since the last snapshot, and I can't answer on-device here — ${why}. ` +
                      `Use the agent mode to send the redacted screen to your configured model.`,
                    tier: 'T0',
                    source: 'unavailable',
                  })
                }
              } else {
                // T1: no network turn when nothing changed. Report it honestly.
                sendToPanel({
                  kind: 'panel:answer',
                  runId: msg.runId,
                  text: `Nothing changed since the last snapshot. No network request was made — the frame-diff gate skipped the redundant frame. ` +
                    `If you want to re-analyse the page, refresh it or ask a different question.`,
                  tier: 'T1',
                  source: 'gate-skipped',
                })
              }
              stage(msg.runId, 'done', 0)
      return { ok: true, skipped: true, tier: run.tier }
    }

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

  // Was a raw `run.stage = 'send'`. `stage()` is what re-arms the watchdog, so
  // the ~13-19s network turn was running inside the snapshot's already-partly
  // spent 45s budget and got reported as a "snapshot" stall — sending the user
  // after worker recycling instead of after the actual cause.
  stage(run.runId, 'send', 0)
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
    stage(run.runId, 'done', now() - t0)
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
  // NOT stage(...,'server'). That name was never in STAGE_TIMEOUT_MS, so it
  // both reset the budget to the 45s default and, being unknown to
  // PIPELINE_ORDER, was treated as the furthest-along position — silently
  // discarding the 60s 'send' budget set moments earlier.
  // The network turn IS 'send'. Report the elapsed time without renaming it.
  const serverMs = now() - t0
  log('sw', `server ${serverMs.toFixed(0)}ms`, 'info')
  flushLog()
  // Sent as a stage ONLY so the panel's waterfall shows the network time. It
  // must not re-arm the watchdog: 'server' is not a stage, and an unknown name
  // resets the budget to the 45s default. The stage remains 'send'.
  sendToPanel({ kind: 'panel:stage', runId: run.runId, stage: 'send', ms: serverMs })

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
    stage(run.runId, 'done', 0)
    return result
  }

  // A failed turn used to be returned and dropped: `callServer` answers
  // `{ok:false, error}` on a non-2xx, a parse failure, an invalid plan, or an
  // AbortController timeout, and none of those reached the panel. The run then
  // sat until the watchdog fired and blamed a stage that was already past.
  stage(run.runId, 'aborted', 0)
  log('sw', `run ${run.runId} server turn failed: ${result.error ?? 'unknown error'}`, 'error')
  flushLog()
  sendToPanel({
    kind: 'panel:error',
    runId: run.runId,
    message:
      `Veil asked the model and got no usable answer (${result.error ?? 'unknown error'}). ` +
      `The page was read and redacted, but no action was taken. ` +
      `Check the server is running, then press Reload.`,
  })
  return result
}

/* ------------------------------------------------------------------ *
 *  Plan execution (§4)
 * ------------------------------------------------------------------ */

/** Steps that must be handed to the human rather than run automatically. */

/**
 * Report what actually happened to the server.
 *
 * `/v1/agent/outcome` existed and was never called by anything, so the server's
 * record of a session contained a first-action attempt and nothing else. The
 * replan machinery — `s.failures`, `s.completed`, `s.declined` — is fed
 * entirely by this endpoint, so with no client the server could never learn
 * that a step failed and would happily propose the same failing plan again.
 *
 * Only counts, action names and a bounded reason are sent. No page content, no
 * values, no DOM. A failure here is logged and swallowed: history must never
 * fail a live turn.
 */
async function reportOutcome(
  sessionId: string,
  body: { action: string; ok: boolean; detail?: string; turn?: number; declined?: string },
): Promise<void> {
  try {
    await fetch(`${serverOrigin}/v1/agent/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, ...body }),
    })
  } catch {
    // Unreachable server is not a run failure; the run already reported itself.
  }
}

/** Convert a run's event log into the outcome calls the server needs. */
async function reportRunOutcome(runId: string, result: PlanRunResult): Promise<void> {
  const run = runs.get(runId)
  if (!run) return
  for (const ev of result.events) {
    if (ev.type === 'failed') {
      await reportOutcome(run.sessionId, {
        action: 'step',
        ok: false,
        detail: ev.reason,
        turn: run.turn,
      })
    } else if (ev.type === 'declined') {
      await reportOutcome(run.sessionId, {
        action: 'step',
        ok: false,
        declined: ev.reason,
        detail: 'the user declined this step',
        turn: run.turn,
      })
    } else if (ev.type === 'executed') {
      await reportOutcome(run.sessionId, { action: 'step', ok: true, turn: run.turn })
    }
  }
}

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

  const res = await runPlan({ steps: plan.steps as PlanStep[] }, driver, {
    // Give an async re-render a moment before the next step resolves its mark
    // against the DOM. 120ms is a re-render budget, not a page-load budget.
    settle: sleep,
  })

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

  // Feed the real result back to the server so the next plan in this session
  // knows what happened instead of repeating the same failing step.
  void reportRunOutcome(runId, res)

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
  // Derived from a measurement, not a guess. `bench/compare_models.py`
  // measured the configured model (Qwen3-VL-32B) at p50 15.7s / p95 24.8s, so
  // the old hardcoded 20s aborted a majority of real turns mid-plan and
  // reported "network error". The budget is the measured p95 with headroom,
  // and it is overridable because a different model has a different tail.
  const t = setTimeout(() => ctrl.abort(), serverTimeoutMs())
  try {
    const res = await fetch(`${serverOrigin}/v1/agent/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, error: `server ${res.status}` }

    // The server answers with `text/event-stream`, so `res.text()` is a
    // `data: {...}` transcript, not JSON. This used to do
    // `JSON.parse(await res.text())`, which threw on EVERY turn — the catch
    // swallowed it and the run finished with no plan, so no server plan had
    // ever actually executed in the extension. parsePlanStream also handles
    // the escalation gate re-streaming a complete replacement plan.
    const raw = await res.text()
    const stream = parsePlanStream(raw)
    if (!stream.ok || stream.text === undefined) {
      return { ok: false, error: stream.error ?? 'could not read the plan' }
    }

    let plan: ActionPlan
    try {
      plan = parseActionPlan(JSON.parse(stream.text))
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'invalid plan' }
    }
    stage(run.runId, 'execute', 0)
    log('sw', `run ${run.runId} plan: ${plan.steps.length} steps confidence=${plan.confidence}`, 'info')
    flushLog()
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

