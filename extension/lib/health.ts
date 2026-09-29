/**
 * The health probe must not report a healthy server as unreachable.
 *
 * THE DEFECT THIS WAS FOUND BY
 * ----------------------------
 * The user pasted a panel showing:
 *
 *   server unreachable (timeout)
 *
 * while the server was, in fact, running and healthy — `/health` returned
 * `provider: openai-compatible` when checked directly. And the run that
 * followed failed for an unrelated reason, so the two looked like one problem.
 *
 * MEASURED, NOT GUESSED: five consecutive `/health` calls against the
 * configured remote provider took 2.87, 2.88, 2.91, 2.99 and 4.79 seconds
 * (median 2.91s). The panel aborted at 4000ms.
 *
 * So the probe sat 800ms inside the distribution on a good day and clipped its
 * tail on a bad one. `AbortError` was then rendered as "timeout", which reads
 * as "the server is down" — and it is worse than useless, because a user who
 * believes the server is down stops restarting it and the real cause goes
 * unexamined.
 *
 * WHY /health IS SLOW AT ALL
 * --------------------------
 * Because it was changed to `await router.resolve()`. The old `router.active()`
 * returned instantly but could not report a provider before the first plan
 * request, which is why the panel used to say "no provider configured" on a
 * server that was configured and working. Resolving honestly costs a probe of
 * the remote endpoint, and that probe is what this timeout has to accommodate.
 *
 * The two fixes are deliberately on different sides:
 *   - a health timeout sized to the measurement, plus
 *   - a SEPARATE, FAST liveness endpoint that does not resolve providers.
 *
 * The second is the important one. "Is the server running?" and "which provider
 * can it reach?" are different questions with wildly different latencies
 * (~5s vs sub-ms), and answering the second to display the first means the
 * panel's status line inherits the remote provider's tail latency.
 */


/** Measured against the configured remote provider. See the header. */
export const MEASURED_HEALTH_P50_MS = 2_910
export const MEASURED_HEALTH_MAX_MS = 4_790

/** The panel's probe budget, from the measurement plus headroom. */
export const HEALTH_TIMEOUT_MS = 15_000

/** The liveness probe budget: no provider resolution, so it is sub-ms. */
export const LIVENESS_TIMEOUT_MS = 2_000

export type HealthDetail = 'ok' | 'timeout' | 'not running' | 'no provider'

/**
 * A timeout is NOT proof the server is down.
 *
 * Separated so the panel can say something true in each case, instead of
 * rendering every failure as "unreachable" and sending the user after the
 * wrong problem.
 */
export function classifyHealth(
  outcome: 'ok' | 'abort' | 'network' | 'http-error' | 'no-provider',
  elapsedMs: number,
): { detail: HealthDetail; unreachable: boolean } {
  switch (outcome) {
    case 'ok':
      return { detail: 'ok', unreachable: false }
    case 'no-provider':
      // The server answered. It just has no usable provider. That is NOT
      // "unreachable" and must never be shown as such.
      return { detail: 'no provider', unreachable: false }
    case 'abort':
      // The server did not answer within HEALTH_TIMEOUT_MS. It MIGHT be down,
      // or it might be slow. Say which, and do not assert it is down.
      return { detail: 'timeout', unreachable: false }
    default:
      return { detail: 'not running', unreachable: true }
  }
}

