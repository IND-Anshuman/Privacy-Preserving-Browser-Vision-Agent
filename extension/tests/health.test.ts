import { describe, it, expect } from 'vitest'
import {
  HEALTH_TIMEOUT_MS,
  LIVENESS_TIMEOUT_MS,
  MEASURED_HEALTH_MAX_MS,
  classifyHealth,
} from '@/lib/health'

describe('health probe timing', () => {
  it('gives /health room for the tail that was actually measured', () => {
    // The old 4000ms clipped a real 4.79s response and reported a healthy
    // server as unreachable. The budget must clear the worst observation.
    expect(HEALTH_TIMEOUT_MS).toBeGreaterThan(MEASURED_HEALTH_MAX_MS)
  })

  it('keeps the fast liveness probe tight', () => {
    // /live does no provider resolution, so it answers in well under a
    // millisecond. A 15s budget there would just delay the real check.
    expect(LIVENESS_TIMEOUT_MS).toBeLessThanOrEqual(2_000)
  })

  it('does not call a slow-but-alive server unreachable', () => {
    const r = classifyHealth('abort', HEALTH_TIMEOUT_MS + 1)
    expect(r.unreachable).toBe(false)
    expect(r.detail).toBe('timeout')
  })

  it('calls a refused connection unreachable', () => {
    expect(classifyHealth('network', 5).unreachable).toBe(true)
  })

  it('does not call an answered-but-unconfigured server unreachable', () => {
    const r = classifyHealth('no-provider', 50)
    expect(r.unreachable).toBe(false)
    expect(r.detail).toBe('no provider')
  })
})
