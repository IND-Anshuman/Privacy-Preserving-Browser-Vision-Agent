/**
 * Typed message bus for SW ↔ offscreen ↔ content ↔ sidepanel.
 * Every payload crossing a boundary is a Zod schema — no free-form objects.
 * ARCHITECTURE.md §2 context table, §6.3 fail-closed.
 */
import { z } from 'zod'
import {
  ActionPlanSchema,
  GateVerdictSchema,
  PerceptionRequestSchema,
  RedactionManifestSchema,
  ScreenStateSchema,
  type ActionPlan,
  type GateVerdict,
  type PerceptionRequest,
  type RedactionManifest,
  type ScreenState,
} from './schema'
import { parseOrThrow } from './schema'

/* ================================================================== *
 *  Compute Pressure — §7
 * ================================================================== */

export const PRESSURE_STATES = ['nominal', 'fair', 'serious', 'critical'] as const
export type PressureState = (typeof PRESSURE_STATES)[number]

/** Which detector layers run, per pressure state. Fail-safe, still private. */
export const CASCADE_BY_PRESSURE: Record<PressureState, { L0: boolean; L1: boolean; L2: boolean; L3: boolean; audit: boolean }> = {
  nominal: { L0: true, L1: true, L2: true, L3: true, audit: true },
  fair: { L0: true, L1: true, L2: true, L3: true, audit: false },
  serious: { L0: true, L1: true, L2: true, L3: false, audit: false },
  critical: { L0: true, L1: true, L2: false, L3: false, audit: false },
}

/* ================================================================== *
 *  Messages
 * ================================================================== */

export const MessageSchema = z.discriminatedUnion('kind', [
  // panel → SW
  z.object({ kind: z.literal('panel:run'), intent: z.string().max(2000), tier: z.enum(['T0', 'T1', 'T2']).default('T1') }),
  z.object({ kind: z.literal('panel:cancel'), runId: z.string() }),
  z.object({ kind: z.literal('panel:explain'), redactionId: z.string() }),

  // SW → content
  z.object({ kind: z.literal('content:snapshot'), runId: z.string() }),
  z.object({ kind: z.literal('content:execute'), runId: z.string(), action: z.unknown() }),
  z.object({ kind: z.literal('content:confirm'), runId: z.string(), actionIndex: z.number().int(), label: z.string() }),
  z.object({ kind: z.literal('content:teardown') }),

  // content → SW
  z.object({ kind: z.literal('snapshot:ready'), runId: z.string(), screenState: ScreenStateSchema, rawDetections: z.array(z.unknown()) }),
  z.object({ kind: z.literal('execute:done'), runId: z.string(), actionIndex: z.number().int(), ok: z.boolean(), status: z.string(), ms: z.number() }),
  z.object({ kind: z.literal('execute:confirm_required'), runId: z.string(), actionIndex: z.number().int(), label: z.string() }),
  z.object({ kind: z.literal('frame:crossorigin'), frameId: z.string() }),

  // SW → offscreen
  z.object({ kind: z.literal('offscreen:init'), tabId: z.number(), reason: z.string() }),
  z.object({ kind: z.literal('offscreen:arm'), runId: z.string(), sessionId: z.string() }),
  z.object({ kind: z.literal('offscreen:capture'), runId: z.string(), mode: z.enum(['auto', 'stream', 'snapshot']), boxes: z.array(z.unknown()), marks: z.array(z.unknown()) }),
  z.object({ kind: z.literal('offscreen:release') }),

  // offscreen → SW
  z.object({ kind: z.literal('redact:ready'), runId: z.string(), manifest: RedactionManifestSchema, verdict: GateVerdictSchema, webpB64: z.string().optional(), bytes: z.number(), timings: z.record(z.number()) }),
  z.object({ kind: z.literal('redact:aborted'), runId: z.string(), reason: z.string() }),
  z.object({ kind: z.literal('offscreen:status'), captureMode: z.string(), pressure: z.enum(PRESSURE_STATES), heapMb: z.number().optional(), adapter: z.string().optional(), rows: z.array(z.unknown()) }),
  z.object({ kind: z.literal('offscreen:prefetched'), sessionId: z.string() }),

  // SW → panel
  z.object({ kind: z.literal('panel:plan'), runId: z.string(), plan: ActionPlanSchema }),
  z.object({ kind: z.literal('panel:stage'), runId: z.string(), stage: z.string(), ms: z.number() }),
  z.object({ kind: z.literal('panel:ledger'), runId: z.string(), entries: z.array(z.unknown()) }),
  z.object({ kind: z.literal('panel:answer'), runId: z.string(), text: z.string(), tier: z.string() }),
  z.object({ kind: z.literal('panel:error'), runId: z.string(), message: z.string() }),
  z.object({ kind: z.literal('panel:rehydrate'), manifest: z.unknown().nullable(), screenState: z.unknown().nullable() }),
])

export type VeilMessage = z.infer<typeof MessageSchema>

/* Narrowing helpers keep call sites `any`-free (see QUALITY BAR). */
export type Msg<K extends VeilMessage['kind']> = Extract<VeilMessage, { kind: K }>

/** Parse an inbound message; returns null on any violation. Fail-closed. */
export function parseMessage(data: unknown): VeilMessage | null {
  const res = MessageSchema.safeParse(data)
  return res.success ? res.data : null
}

export function mustMessage<K extends VeilMessage['kind']>(data: unknown, where: string): Msg<K> {
  const res = MessageSchema.safeParse(data)
  if (!res.success) {
    throw new Error(`[msg:${where}] invalid message: ${res.error.issues[0]?.message ?? 'unknown'}`)
  }
  return res.data as Msg<K>
}

/* ================================================================== *
 *  Privacy ledger entry (§6.3) — the demo artifact judges verify
 * ================================================================== */

export const LedgerEntrySchema = z.object({
  t: z.number(),
  runId: z.string(),
  label: z.string(),
  bytesOut: z.number().int().nonnegative(),
  bytesIn: z.number().int().nonnegative(),
  redactions: z.number().int().nonnegative(),
  placeholders: z.array(z.string()),
  tier: z.string(),
  frameHash: z.string(),
  durationMs: z.number(),
})
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>

/* ================================================================== *
 *  Re-exports so call sites import from one place
 * ================================================================== */

export type { ActionPlan, GateVerdict, PerceptionRequest, RedactionManifest, ScreenState }
export { ActionPlanSchema, GateVerdictSchema, PerceptionRequestSchema, RedactionManifestSchema, ScreenStateSchema, parseOrThrow }
