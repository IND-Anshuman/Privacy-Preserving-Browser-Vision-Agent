/**
 * Compute Pressure adaptive cascade — ARCHITECTURE.md §7.
 *
 * The point of this file is visible degradation: when the machine is loaded we
 * shed the expensive detector layers rather than stalling. L0/L1 never go away,
 * so the privacy property holds at every pressure level — we get slower and
 * less precise about PERSON/ORG, never less private.
 */
import { CASCADE_BY_PRESSURE, type PressureState } from '@/lib/messages'

export interface CascadePlan {
  state: PressureState
  L0: boolean
  L1: boolean
  L2: boolean
  L3: boolean
  audit: boolean
  /** Human-readable reason, shown in the HUD. */
  why: string
}

const REASONS: Record<PressureState, string> = {
  nominal: 'system idle — full cascade',
  fair: 'light load — skipping the VLM audit pass',
  serious: 'busy — pixel detectors deferred, DOM NER only',
  critical: 'under heavy load — regex + semantics only',
}

export function planFor(state: PressureState): CascadePlan {
  const c = CASCADE_BY_PRESSURE[state]
  return { state, ...c, why: REASONS[state] }
}

export interface PressureTransition {
  at: number
  from: PressureState
  to: PressureState
}

/**
 * The DOM lib does not ship PressureObserver types yet, so the surface we use
 * is declared here. Only `observe`/`disconnect` on the 'cpu' source matter.
 */
interface PressureObserverLike {
  observe(type: string, opts?: { sampleInterval?: number }): void
  disconnect(): void
}

/**
 * Observe CPU pressure. PressureObserver works in window, dedicated-worker and
 * shared-worker contexts, so this runs directly in the offscreen document.
 * Every transition is recorded and broadcast to the HUD.
 */
export class PressureMonitor {
  private observer: PressureObserverLike | null = null
  private state: PressureState = 'nominal'
  private readonly history: PressureTransition[] = []

  get current(): PressureState {
    return this.state
  }

  get transitions(): PressureTransition[] {
    return [...this.history]
  }

  get supported(): boolean {
    return typeof (globalThis as { PressureObserver?: unknown }).PressureObserver === 'function'
  }

  /**
   * `cpu` pressure is the signal we want. If the API is missing we stay at
   * 'nominal' and the cascade runs at full strength — documented degradation,
   * never a silent downgrade.
   */
  start(onChange: (p: CascadePlan) => void): void {
    const Ctor = (globalThis as {
      PressureObserver?: new (cb: (records: Array<{ source?: string; pressureState?: string }>) => void) => PressureObserverLike
    }).PressureObserver

    if (!Ctor) {
      onChange(planFor('nominal'))
      return
    }

    this.observer = new Ctor((records) => {
      for (const r of records) {
        if (r.source !== 'cpu') continue
        const next = normalize(r.pressureState)
        if (next === this.state) continue
        this.history.push({ at: Date.now(), from: this.state, to: next })
        this.state = next
        onChange(planFor(next))
      }
    })

    try {
      this.observer.observe('cpu', { sampleInterval: 1000 })
    } catch {
      // Some builds expose the constructor but not the 'cpu' source.
      onChange(planFor('nominal'))
    }
  }

  stop(): void {
    this.observer?.disconnect()
    this.observer = null
  }

  /** Test/demo hook: force a state without a real pressure source. */
  force(state: PressureState): CascadePlan {
    const from = this.state
    this.state = state
    if (from !== state) this.history.push({ at: Date.now(), from, to: state })
    return planFor(state)
  }
}

function normalize(s: string | undefined): PressureState {
  switch ((s ?? '').toLowerCase()) {
    case 'critical':
      return 'critical'
    case 'serious':
      return 'serious'
    case 'fair':
      return 'fair'
    default:
      return 'nominal'
  }
}
