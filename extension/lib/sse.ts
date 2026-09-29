/**
 * Server-stream parsing.
 *
 * The server answers `/v1/agent/step` with `text/event-stream`, and the client
 * used to do `parseActionPlan(JSON.parse(await res.text()))` on that body. The
 * body is not JSON — it is `data: {...}` lines — so the parse threw on every
 * turn, the catch swallowed it, and the run finished quietly with no plan at
 * all. Every plan from a real server failed; the grounding benchmark missed it
 * because it calls the provider directly and never touches this code.
 *
 * The subtle part is the escalation gate. When the server replaces an
 * untrustworthy plan it re-streams the ENTIRE replacement as one delta, after
 * the original chunks have already gone out. So:
 *
 *   - deltas concatenate into the plan JSON, AND
 *   - a delta that is itself a complete plan REPLACES what came before.
 *
 * Naively appending produces two JSON documents back to back, and the
 * replacement — the one that actually matters — is discarded with the parse
 * error.
 */

export interface StreamResult {
  ok: boolean
  /** The reassembled plan JSON, when `ok`. */
  text?: string
  error?: string
}

/** Does this text parse as a complete JSON object? */
function isCompleteJson(text: string): boolean {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

export function parsePlanStream(raw: string): StreamResult {
  // Tolerate a stream that arrived as one read and one that was already split.
  const body = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = body.split('\n')

  let acc = ''
  let sawData = false

  for (const line of lines) {
    const t = line.trim()
    // Heartbeats and comments are not data.
    if (!t || t.startsWith(':')) continue
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    sawData = true

    let env: unknown
    try {
      env = JSON.parse(payload)
    } catch {
      continue
    }
    if (typeof env !== 'object' || env === null) continue
    const delta = (env as { delta?: unknown }).delta
    if (typeof delta !== 'string') continue

    // A complete JSON document arriving whole is a REPLACEMENT, not a
    // continuation. This is the escalation-gate re-stream.
    if (isCompleteJson(delta)) {
      acc = delta
      continue
    }

    acc += delta
    // The replacement may have arrived as a continuation that completes the
    // previously accumulated text; once it parses, prefer the longer document.
    if (isCompleteJson(acc)) continue
  }

  if (!sawData || !acc.trim()) {
    return { ok: false, error: 'the server sent no plan' }
  }
  if (!isCompleteJson(acc)) {
    return {
      ok: false,
      error: `the plan stream ended mid-JSON after ${acc.length} characters`,
    }
  }
  return { ok: true, text: acc }
}
