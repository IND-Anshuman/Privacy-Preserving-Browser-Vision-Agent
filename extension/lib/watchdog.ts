/**
 * A run that cannot finish must still be REPORTED as not finishing.
 *
 * THE BUG THIS FIXES
 * ------------------
 * `runs` is a plain `Map` in the service worker. MV3 terminates an idle
 * service worker after ~30 seconds, and a T1 turn measures p50 ~13s / p95 ~19s
 * against a remote model — so the full pipeline (snapshot -> capture ->
 * redact -> send -> plan -> execute) outlives the worker itself.
 *
 * When the worker dies mid-run:
 *   - the `runs` entry is gone
 *   - nothing calls the terminal handlers
 *   - so `panel:plan` / `panel:answer` / `panel:error` / `redact:aborted`
 *     are never sent
 *   - and the panel's `busy` flag, which is cleared by exactly those four,
 *     stays true forever.
 *
 * That is the report "it starts working and never stops". There is no error,
 * because the thing that would have reported the error is what died.
 *
 * WHAT THIS DOES
 * --------------
 * 1. A per-run timer. If a run is still in a non-terminal stage after its
 *    budget, the panel is told, by name, which stage stalled.
 * 2. An orphan check. After a worker restart there is no run at all, so the
 *    per-run timer has nothing to fire. The panel knows it asked for
 *    something and never got an answer, so the panel runs its own deadline.
 * 3. An honest message. "The extension was stopped while contacting the
 *    model" is actionable. "Something went wrong" is not.
 *
 * WHAT THIS IS NOT
 * -----------------
 * It does not make the worker live longer, and it does not resume an
 * orphaned run — the state to resume it is gone. It converts a silent hang
 * into a visible, explained failure. Persisting run state well enough to
 * resume after a restart is the larger fix and is not here.
 */

export type RunStage = 'snapshot' | 'capture' | 'redact' | 'send' | 'execute' | 'done' | 'aborted'

/** Stages after which nothing more is coming. */
const TERMINAL: ReadonlySet<string> = new Set(['done', 'aborted'])

export function isTerminalStage(stage: string): boolean {
  return TERMINAL.has(stage)
}

export interface StalledRun {
  runId: string
  stage: string
  elapsedMs: number
}

export interface WatchdogOptions {
  /**
   * Overrides EVERY per-stage budget with one flat deadline.
   *
   * Deliberately absent in production: the whole point of STAGE_TIMEOUT_MS is
   * that a 13-19s network turn and a 12ms page walk do not deserve the same
   * deadline, and passing a flat number here would silently flatten the table
   * again — which is the bug this file was written to remove. It exists so
   * tests can drive timeouts in milliseconds, and so a future config can force
   * a strict overall cap if one is ever wanted.
   */
  timeoutMs?: number
  onExpire: (run: StalledRun) => void
  /** A stage was reported out of order. Diagnostic only. */
  onRewind?: (runId: string, from: string, to: string) => void
}

/**
 * The order stages must be reported in.
 *
 * Deliberately not alphabetical and not arbitrary: this is the order the
 * pipeline executes them, which is the only order in which "the run is at
 * stage X" is a true statement.
 */
export const PIPELINE_ORDER: readonly string[] = Object.freeze([
  'snapshot',
  'capture+redact',
  'redact',
  'send',
  'execute',
  'done',
  'aborted',
])

/** Terminal stages sort last so nothing can follow them. */
function orderIndex(stage: string): number {
  const i = PIPELINE_ORDER.indexOf(stage)
  // An unknown stage is not a rewind — refusing it would silently swallow a
  // legitimate new stage. Treat it as the current position.
  return i === -1 ? PIPELINE_ORDER.length : i
}

/**
 * Budget for one run.
 *
 * Not a round number: the measured pipeline is p50 ~13s for the network turn
 * alone, and the local stages add ~62ms of compute plus capture and composite
 * time that a script cannot measure. 30s of wall clock is therefore already
 * generous, and a run still going at 45s is not slow — it is stuck.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 45_000

/**
 * Per-stage deadlines.
 *
 * ONE DEADLINE FOR THE WHOLE RUN IS THE WRONG SHAPE, and the trace below is
 * what proved it. A user pasted:
 *
 *   [veil:sw] snapshot: 15 marks, 1 L0/L1 hits, opaque=0
 *   [veil:sw] capture+redact 2ms
 *   [veil:sw] snapshot 37ms
 *   [veil:sw] run ... stalled in "snapshot" after 45s
 *
 * The snapshot finished in 37ms and capture/redact in 2ms, yet the stall was
 * reported as being in "snapshot". The cause: `onRedactReady` sets
 * `run.stage = 'send'` as a RAW ASSIGNMENT instead of calling `stage()`, and
 * `stage()` is the only thing that re-arms the watchdog. So the timer was
 * still counting from the snapshot while a ~13-19s network turn ran inside a
 * 45s window that was never extended. The user was sent chasing MV3 worker
 * recycling, which had nothing to do with it.
 *
 * So: every stage gets a deadline sized to what it actually does. The local
 * page walk measured p50 12.67ms, the whole client scan 62.2ms — those get
 * seconds, not a minute. The network turn measures p50 ~13s and p95 ~19s, so
 * it gets the room it needs, and it gets a deadline of its own rather than
 * inheriting one measured from the snapshot.
 */
export const STAGE_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze({
  /** Local DOM walk. Measured p50 12.67ms; even a huge page is well under 1s. */
  snapshot: 8_000,
  /** Frame capture + compositor setup. GPU-bound, no network. */
  capture: 15_000,
  /**
   * The name the pipeline actually emits. It was absent from this table, so it
   * fell back to the 45s default — which is why a run that hung during capture
   * got a 45s wait, the same as a network turn.
   */
  'capture+redact': 15_000,
  /** L0/L1 + optional L2/L3. Warm L3 measured ~632ms; allow for model load. */
  redact: 30_000,
  /** The remote T1 turn. Measured p50 13.00s, p95 18.94s, one 74s stall. */
  send: 60_000,
  /** Local click/fill + effect verification. */
  execute: 20_000,
})

/** The deadline for a stage, falling back to the run-wide budget. */
export function stageTimeoutMs(stage: string): number {
  return STAGE_TIMEOUT_MS[stage] ?? DEFAULT_RUN_TIMEOUT_MS
}

/**
 * One in-flight run at a time, which is all the panel allows (`runIntent`
 * returns early when `state.busy`). Modelling it as a single slot keeps this
 * impossible to get wrong; a Map keyed by runId would be a place to forget an
 * entry and leak a timer.
 */
export class RunWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null
  private current: { runId: string; stage: string; startedAt: number } | null = null

  constructor(private readonly opts: WatchdogOptions) {}

  /**
   * Start (or advance) the run.
   *
   * A repeat `begin` for the SAME run deliberately does NOT restart the clock.
   * The service worker receives a stage message for every transition, and
   * resetting on each one would let a genuinely wedged run hold the panel
   * hostage indefinitely — reintroducing the exact hang this fixes.
   */
  begin(runId: string, stage: string): void {
    if (this.current && this.current.runId === runId) {
      // Same run, same stage: a repeat message. Do NOT restart the clock — a
      // wedged run that keeps emitting would otherwise hold the panel
      // hostage forever, reintroducing the hang this exists to prevent.
      if (this.current.stage === stage) return

      // A REWIND IS REFUSED.
      //
      // The user pasted this trace:
      //   capture+redact 2ms
      //   snapshot 44ms
      //   run ... stalled in "snapshot" after 45s
      //
      // Stages are emitted from inside an await: the content script answers
      // `content:snapshot` by awaiting its own `snapshot:ready`, so the whole
      // onSnapshotReady handler — including its stage('capture+redact') —
      // runs BEFORE startRun resumes and reports 'snapshot'. The last stage
      // reported was therefore one that had already finished, and a 13-19s
      // network turn was reported as a "snapshot" stall.
      //
      // A stage can only move forward. If a caller reports an earlier stage
      // than the run has already reached, that is a bug in the call ordering
      // — silently honouring it makes the watchdog name the wrong stage, which
      // is the whole failure being fixed.
      if (orderIndex(stage) < orderIndex(this.current.stage)) {
        this.opts.onRewind?.(this.current.runId, this.current.stage, stage)
        return
      }
      // Same run, ADVANCED stage. Re-arm, because the new stage is a different
      // kind of work with a different budget. Not restarting here is what made
      // the network turn inherit the snapshot's already-spent 45s.
      this.current.stage = stage
      this.current.startedAt = Date.now()
      this.arm(stage)
      return
    }
    this.clear()
    this.current = { runId, stage, startedAt: Date.now() }
    this.arm(stage)
  }

  private arm(stage: string): void {
    if (this.timer !== null) clearTimeout(this.timer)
    // A flat override wins when given; otherwise the per-stage budget applies.
    const budget = this.opts.timeoutMs ?? stageTimeoutMs(stage)
    this.timer = setTimeout(() => {
      const c = this.current
      this.clear()
      if (c) {
        this.opts.onExpire({
          runId: c.runId,
          stage: c.stage,
          elapsedMs: Date.now() - c.startedAt,
        })
      }
    }, budget)
  }

  /** The run reached a terminal state; stop caring. */
  finish(runId: string): void {
    if (this.current?.runId === runId) this.clear()
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.current = null
  }
}

export function newWatchdog(opts: WatchdogOptions): RunWatchdog {
  return new RunWatchdog(opts)
}

/**
 * The message the user actually reads.
 *
 * It names the stage because "it stopped" gives the reader nothing to act on,
 * and it says what did NOT happen, because the whole promise of this extension
 * is that a redacted frame either went to the configured model or did not.
 */
export function describeRunError(run: StalledRun): string {
  const where =
    run.stage === 'send'
      ? 'while contacting the model'
      : run.stage === 'redact'
        ? 'while redacting the page'
        : run.stage === 'execute'
          ? 'while acting on the page'
          : run.stage === 'snapshot'
            ? 'while reading the page'
            : 'during the run'

  return (
    `Veil stopped ${where} and did not finish (${Math.round(run.elapsedMs / 1000)}s). ` +
    // This used to assert "the background worker is restarted by the browser
    // when it goes idle, which is the usual cause". It was wrong: a user hit
    // this with the worker alive and healthy, because the stage name was
    // stale. Naming a cause we cannot observe sends the reader after the wrong
    // problem — that cost one debugging round-trip on a real report.
    `Nothing further was sent. The step that stalled was ` +
    `**${run.stage}** (budget ${Math.round(stageTimeoutMs(run.stage) / 1000)}s). ` +
    `The most common causes: the step took longer than its budget, or the ` +
    `browser restarted the background worker while it was idle. ` +
    `Press Reload to try again — with a remote model, expect 10–20s per turn.`
  )
}

/**
 * A one-shot deadline for a single stage.
 *
 * WHY IT IS A SEPARATE OBJECT AND NOT A FLAG
 * ------------------------------------------
 * The first version of this was a boolean plus a timer in background.ts, and
 * it fired on healthy runs. The cause was an ordering mistake, and the mistake
 * was possible at all because arming and clearing were free-floating statements
 * with no shared owner — `armStageDeadline()` at the bottom of startRun and a
 * bare `clearStageDeadline()` inside a different function, ~200 lines away.
 * Nothing in the type system connected the two, and nothing in a test could
 * reach them.
 *
 * So the discipline is now an object with a single owner:
 *
 *   - `begin()` is called BEFORE the work starts. Not after. The content script
 *     answers `content:snapshot` by awaiting its own `snapshot:ready` and only
 *     then returning, so the event arrives *during* the await. Arming after the
 *     await means arming after the event has already been handled — a clear()
 *     that ran earlier disarms a timer that did not exist yet, and the deadline
 *     is then guaranteed to fire on a run that has moved on.
 *   - `end()` cancels it, and is safe to call whether or not `begin()` ran.
 *   - `fire()` is what a re-arm-on-stage-change does NOT do; a repeat event
 *     leaves the clock alone.
 *
 * A late `begin()` is still caught: `begin()` returns false if the stage is
 * already past, so the caller cannot arm a deadline it has already outrun.
 */
export class StageDeadline {
  private timer: ReturnType<typeof setTimeout> | null = null
  private armedFor: string | null = null
  /** Runs whose deadline has already been resolved. Bounded by run count. */
  private readonly settled = new Set<string>()

  /**
   * Arm for `stage`, BEFORE the work starts.
   *
   * Returns false when this run's deadline is already settled, so a caller
   * that is somehow late cannot arm a timer for an event that has passed.
   */
  begin(runId: string, stage: string, ms: number, onExpire: (stage: string) => void): boolean {
    if (this.settled.has(runId)) return false
    this.cancel()
    this.armedFor = `${runId}:${stage}`
    this.timer = setTimeout(() => {
      this.timer = null
      this.armedFor = null
      this.settled.add(runId)
      onExpire(stage)
    }, ms)
    return true
  }

  /**
   * Cancel. Safe at any time, including when nothing is armed — which is the
   * point: the event this watches can legitimately arrive before `begin()` was
   * reached, and that must settle the deadline rather than leave it armed.
   */
  end(runId: string): void {
    this.settled.add(runId)
    this.cancel()
  }

  /** Forget a settled run. Called on terminal transitions to keep this bounded. */
  forget(runId: string): void {
    this.settled.delete(runId)
  }

  private cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.armedFor = null
  }

  /** Diagnostic view — which run:stage is armed, if any. */
  get armed(): string | null {
    return this.armedFor
  }
}
