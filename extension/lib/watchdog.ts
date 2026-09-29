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

export type RunStage = 'snapshot' | 'redact' | 'send' | 'execute' | 'done' | 'aborted'

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
  timeoutMs: number
  onExpire: (run: StalledRun) => void
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
      this.current.stage = stage
      return
    }
    this.clear()
    this.current = { runId, stage, startedAt: Date.now() }
    this.timer = setTimeout(() => {
      const c = this.current
      this.clear()
      if (c) this.opts.onExpire({ runId: c.runId, stage: c.stage, elapsedMs: Date.now() - c.startedAt })
    }, this.opts.timeoutMs)
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
    `The background worker is restarted by the browser when it goes idle, which ` +
    `is the usual cause. Nothing was sent after that point. Press Reload to try again — ` +
    `if a remote model is configured, expect this turn to take 10–20s.`
  )
}
