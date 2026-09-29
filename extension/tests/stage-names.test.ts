/**
 * Every stage name the pipeline emits must be one the watchdog understands.
 *
 * THE DEFECTS THIS PREVENTS, all found the same way — by reading a trace the
 * user pasted rather than by reading the code:
 *
 *   capture+redact 2ms
 *   snapshot 44ms
 *   run ... stalled in "snapshot" after 45s
 *
 * Three separate causes, one shared shape: a stage NAME that exists at the
 * call site but not in the tables.
 *
 *   1. `stage(run.runId, 'server', ...)` — 'server' was not in
 *      STAGE_TIMEOUT_MS, so it fell back to the 45s default AND, being unknown
 *      to PIPELINE_ORDER, was treated as the furthest-along stage, discarding
 *      the 60s 'send' budget set moments earlier.
 *   2. `capture+redact` was not in STAGE_TIMEOUT_MS either, so a run that hung
 *      during capture waited 45s instead of 15s.
 *   3. `newWatchdog({timeoutMs: 45_000})` in background.ts overrode the entire
 *      per-stage table, because arm() resolves `opts.timeoutMs ?? stage(stage)`.
 *      The table's own tests passed; nothing tested the WIRING.
 *
 * A typo in a stage string is silent: the run still completes, and the only
 * symptom is a deadline that is wrong by a factor of three. So this test reads
 * background.ts and checks every emitted name against the tables.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STAGE_TIMEOUT_MS, PIPELINE_ORDER, DEFAULT_RUN_TIMEOUT_MS } from '@/lib/watchdog'

const SRC = readFileSync(resolve(__dirname, '../entrypoints/background.ts'), 'utf8')

/**
 * Source with comments stripped.
 *
 * The explanatory comments in this project name the stage strings they explain
 * ("NOT stage(...,'server')"), so a raw-text scan matches prose and reports
 * bugs that are not in the code. Only executable source is interesting here.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** Every stage string passed to stage(...) or a panel:stage message. */
function emittedStages(): string[] {
  const out = new Set<string>()
  for (const m of CODE.matchAll(/\bstage\(\s*[\w.]+,\s*'([a-z+]+)'/g)) out.add(m[1]!)
  for (const m of CODE.matchAll(/stage:\s*'([a-z+]+)'/g)) out.add(m[1]!)
  return [...out]
}

describe('stage names are consistent across the pipeline', () => {
  it('finds the call sites it is meant to check', () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true — the same failure as testing a stand-in instead of the
    // real code.
    expect(emittedStages().length).toBeGreaterThan(3)
  })

  it('every emitted stage is a known stage', () => {
    const known = new Set(PIPELINE_ORDER)
    const unknown = emittedStages().filter((s) => !known.has(s))
    expect(
      unknown,
      `these stage names are emitted but not in PIPELINE_ORDER: ${unknown.join(', ')}. ` +
        `An unknown name silently falls back to the 45s default.`,
    ).toEqual([])
  })

  it('every stage in the pipeline order has an explicit budget', () => {
    const missing = PIPELINE_ORDER.filter(
      (s) => s !== 'done' && s !== 'aborted' && STAGE_TIMEOUT_MS[s] === undefined,
    )
    expect(
      missing,
      `these stages have no budget and fall back to ${DEFAULT_RUN_TIMEOUT_MS}ms: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('production does not override the per-stage table with one flat number', () => {
    const ctor = CODE.slice(CODE.indexOf('const watchdog = newWatchdog('))
    const head = ctor.slice(0, ctor.indexOf('onExpire'))
    expect(
      head,
      'background.ts passes timeoutMs, which makes arm() ignore STAGE_TIMEOUT_MS entirely. ' +
        'The per-stage budgets are then dead code in production — which is exactly what happened.',
    ).not.toMatch(/timeoutMs\s*:/)
  })
})
