import { describe, it, expect } from 'vitest'
import { parsePlanStream } from '../lib/sse'

/**
 * The client parses the server's response — and the server streams SSE.
 *
 * `callServer` did `parseActionPlan(JSON.parse(await res.text()))` against a
 * `text/event-stream` body. `res.text()` is
 *
 *     data: {"delta":"{\"schema_version\""}
 *     data: {"delta":"..."}
 *     data: [DONE]
 *
 * which is not JSON, so `JSON.parse` threw on every single turn and the
 * catch returned `{ok:false}`. Every plan from a real server had therefore
 * failed at the client, and the "8/8 grounded" benchmark never exercised this
 * code path because it calls the provider directly.
 *
 * Two rules, both learned the hard way from the real stream:
 *
 *  1. Deltas CONCATENATE into the plan JSON.
 *  2. When the escalation gate replaces a plan, the server re-streams the WHOLE
 *     replacement as one delta AFTER the original chunks. Concatenating
 *     everything yields two JSON documents back to back ("Extra data"), so the
 *     replacement must REPLACE the accumulated text rather than append.
 */

/** The exact bytes a real server sends for a two-chunk, ungated plan. */
const STREAM_UNGATED = [
  'data: {"delta":"{\\"schema_version\\":\\"1.0.0\\","}',
  '',
  'data: {"delta":"\\"steps\\":[]}"}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

/** The gated case: original chunks, then the full replacement plan. */
const STREAM_GATED = [
  'data: {"delta":"{\\"schema_version\\":\\"1.0.0\\",\\"steps\\":[{\\"action\\":\\"click\\"}]}"}',
  '',
  'data: {"delta":"{\\"schema_version\\":\\"1.0.0\\",\\"steps\\":[{\\"action\\":\\"ask_user\\",\\"reason\\":\\"mark 999 does not exist\\"}]}"}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

describe('plan stream parsing', () => {
  it('reassembles a plan from streamed deltas', () => {
    const raw = parsePlanStream(STREAM_UNGATED)
    expect(raw.ok).toBe(true)
    expect(JSON.parse(raw.text!).steps).toEqual([])
  })

  it('a gated plan REPLACES the original rather than appending to it', () => {
    // Concatenating here produces two documents and a JSON "Extra data" error —
    // the client would then discard a perfectly good replacement plan.
    const raw = parsePlanStream(STREAM_GATED)
    expect(raw.ok).toBe(true)
    const plan = JSON.parse(raw.text!)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].action).toBe('ask_user')
    expect(plan.steps[0].reason).toContain('999')
  })

  it('does not report a run as successful on an unparseable stream', () => {
    // The failure that shipped: JSON.parse threw, the catch swallowed it, and
    // the run ended quietly with no plan. An error must be an error.
    const raw = parsePlanStream('data: {"delta":"not json at all"}')
    expect(raw.ok).toBe(false)
    expect(raw.error).toBeTruthy()
  })

  it('handles an empty stream as a failure, not as an empty plan', () => {
    const raw = parsePlanStream('data: [DONE]\n\n')
    expect(raw.ok).toBe(false)
  })

  it('is not fooled by a [DONE] that carries no data', () => {
    expect(parsePlanStream('').ok).toBe(false)
  })

  it('tolerates CRLF line endings', () => {
    const crlf = STREAM_UNGATED.replace(/\n/g, '\r\n')
    expect(parsePlanStream(crlf).ok).toBe(true)
  })

  it('ignores comment/heartbeat lines', () => {
    const withNoise = `: keep-alive\n${STREAM_UNGATED}`
    expect(parsePlanStream(withNoise).ok).toBe(true)
  })
})
