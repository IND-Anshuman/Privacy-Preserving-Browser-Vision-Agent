/**
 * Zod contract for every artifact that crosses a process or network boundary.
 * ARCHITECTURE.md §4 and §6.1 are binding: this file is the machine-readable
 * restatement of them. Nothing in the extension may serialize a payload that has
 * not been parsed by these schemas first (fail-closed, §6.3).
 */
import { z } from 'zod'

export const SCHEMA_VERSION = '1.0.0'

/* ------------------------------------------------------------------ *
 *  PII taxonomy (§5). Classes are the union of detector layers and the
 *  units of the placeholder grammar in §6.1.
 * ------------------------------------------------------------------ */

export const PII_CLASSES = [
  'PASSWORD',
  'PERSON',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'CREDIT_CARD',
  'AADHAAR',
  'PAN',
  'GSTIN',
  'IFSC',
  'IBAN',
  'PASSPORT',
  'DL',
  'DOB',
  'IP_ADDRESS',
  'API_KEY',
  'JWT',
  'BANK_ACCOUNT',
  'ORG',
  'MONEY',
  'LOCATION',
  'DATE',
  'FACE',
  /**
   * A region we cannot inspect and therefore cannot redact: a cross-origin
   * frame that refused injection, a cross-origin `embed`/`object`, or a
   * `<canvas>`/`<video>` whose contents L3 has not cleared.
   *
   * This is not a PII class and it never appears in the manifest as one. It is
   * the §6.3 fail-closed rule expressed as data: the compositor fills the whole
   * region solid, and the ledger reports it as "not inspected" rather than
   * pretending the content was classified.
   */
  'OPAQUE_REGION',
] as const
export type PiiClass = (typeof PII_CLASSES)[number]

/** A frame or media region the client could not inspect. */
export interface OpaqueFrame {
  /** For the ledger and the manifest. Never rendered into a prompt. */
  src: string
  x: number
  y: number
  w: number
  h: number
}

/** Source layer that produced a hit — kept for the cascade-delta benchmark (M2). */
export const PII_SOURCES = ['L0', 'L1', 'L2', 'L3'] as const
export type PiiSource = (typeof PII_SOURCES)[number]

/** §6.1 — three redaction methods, chosen per item. */
export const REDACTION_METHODS = ['solid_fill', 'pixelate', 'placeholder'] as const
export type RedactionMethod = (typeof REDACTION_METHODS)[number]

/** Value classes for the DOM channel. A node is never sent as `sensitive`. */
export const VALUE_CLASSES = ['sensitive', 'public', 'masked'] as const
export type ValueClass = (typeof VALUE_CLASSES)[number]

/* ------------------------------------------------------------------ *
 *  Geometry
 * ------------------------------------------------------------------ */

export const BoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
})
export type Box = z.infer<typeof BoxSchema>

/* ------------------------------------------------------------------ *
 *  Detection hit (§5 fusion): (class, source, score, rect, span)
 * ------------------------------------------------------------------ */

export const DetectionSchema = z.object({
  id: z.string().min(1),
  /** PII class, or FACE for L3 detections. */
  cls: z.enum(PII_CLASSES),
  source: z.enum(PII_SOURCES),
  /** Detector confidence in [0,1]. Fused score is computed in fusion.ts. */
  score: z.number().min(0).max(1),
  /** Viewport-space box in CSS px. Absent for pure-text hits with no element. */
  box: BoxSchema.optional(),
  /** Offsets into the source string, for text-channel items. */
  span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  /** The matched text. NEVER sent to the server; local-only, used for pseudonymizing. */
  text: z.string().optional(),
  /** Pixel channel only: the recovered string, re-run through L1/L2. */
  sourceRect: BoxSchema.optional(),
})
export type Detection = z.infer<typeof DetectionSchema>

/* ------------------------------------------------------------------ *
 *  Stable, per-session pseudonymization (§6.1)
 *  Salt never leaves the client; identical input → identical token within a session.
 * ------------------------------------------------------------------ */

export const PlaceholderSchema = z.object({
  token: z.string().regex(/^\[[A-Z_]+_\d+\]$/, 'placeholder must look like [PERSON_1]'),
  cls: z.enum(PII_CLASSES),
})
export type Placeholder = z.infer<typeof PlaceholderSchema>

/* ------------------------------------------------------------------ *
 *  Redaction manifest (§6.3) — signed, sent with every request
 * ------------------------------------------------------------------ */

export const RedactionEntrySchema = z.object({
  id: z.string().min(1),
  box: BoxSchema,
  cls: z.enum(PII_CLASSES),
  placeholder: PlaceholderSchema,
  method: z.enum(REDACTION_METHODS),
  score: z.number().min(0).max(1),
  /** Which detector layer justified this redaction. */
  source: z.enum(PII_SOURCES),
  /** Pixel channel: true when the box came from a detector, not a DOM rect. */
  pixelDerived: z.boolean(),
})
export type RedactionEntry = z.infer<typeof RedactionEntrySchema>

export const RedactionManifestSchema = z.object({
  schema_version: z.string().min(1),
  session_id: z.string().min(8),
  redactions: z.array(RedactionEntrySchema),
  frame_hash: z.string().regex(/^[0-9a-f]{16,64}$/),
  /**
   * A non-cryptographic content digest over the canonical manifest, bound to
   * the frame hash. It detects corruption and truncation. It is NOT an HMAC and
   * proves nothing about who produced it — see `signManifest` in redact.ts for
   * why a client-side key could not be a real boundary anyway. §6.3.
   */
  signature: z.string().min(16),
  model_versions: z.object({
    l2_ner: z.string(),
    l3_face: z.string(),
    l3_text: z.string(),
    runtime: z.string(),
  }),
  /** Why the gate refused to emit, when it did. Empty on a passing run. */
  abort_reason: z.string().nullable(),
})
export type RedactionManifest = z.infer<typeof RedactionManifestSchema>

/* ------------------------------------------------------------------ *
 *  screen_state.json — the DOM channel artifact (§4)
 * ------------------------------------------------------------------ */

export const ACTION_NAMES = [
  'click',
  'fill',
  'focus',
  'select',
  'scroll',
  'hover',
  'navigate',
  'extract',
  'wait_for',
  'ask_user',
  'none',
] as const
export type ActionName = (typeof ACTION_NAMES)[number]

/** §4 — destructive set always requires a client-side confirmation. */
export const DESTRUCTIVE_ACTIONS = ['submit', 'send', 'pay', 'delete'] as const

export const ScreenNodeSchema: z.ZodType<ScreenNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    role: z.string().min(1),
    label: z.string().max(200).optional(),
    /** valueType, e.g. text / password / email / tel / number / checkbox / none. */
    valueType: z.string().default('none'),
    /** A sensitive value is never serialized — it leaves as the placeholder token. */
    value: z.string().max(200).optional(),
    valueClass: z.enum(VALUE_CLASSES),
    bbox: BoxSchema.optional(),
    /** Set-of-Mark number burned over the element in screen.webp (§4). */
    mark: z.number().int().nonnegative().optional(),
    actions: z.array(z.enum(ACTION_NAMES)).default([]),
    children: z.array(ScreenNodeSchema).default([]),
  }),
)
export interface ScreenNode {
  id: string
  role: string
  label?: string
  valueType?: string
  value?: string
  valueClass: ValueClass
  bbox?: Box
  mark?: number
  actions?: ActionName[]
  children?: ScreenNode[]
}

export const ScreenStateSchema = z.object({
  schema_version: z.string().min(1),
  session_id: z.string().min(8),
  /** Frame this state was sampled against; must equal manifest.frame_hash. */
  frame_hash: z.string().regex(/^[0-9a-f]{16,64}$/),
  url: z.string().max(2000),
  title: z.string().max(300),
  root: ScreenNodeSchema,
  /** Marks assigned this cycle, in assignment order. */
  mark_count: z.number().int().nonnegative(),
})
export type ScreenState = z.infer<typeof ScreenStateSchema>

/* ------------------------------------------------------------------ *
 *  Action plan — the server's answer (§4, §9)
 * ------------------------------------------------------------------ */

export const ActionTargetSchema = z.object({
  mark: z.number().int().nonnegative().optional(),
  selector: z.string().max(500).optional(),
  role: z.string().max(100).optional(),
  name: z.string().max(200).optional(),
})
export type ActionTarget = z.infer<typeof ActionTargetSchema>

export const ActionSchema = z.object({
  action: z.enum(ACTION_NAMES),
  target: ActionTargetSchema.optional(),
  /** Fill text. Sensitive values may only appear as [TYPE_n] tokens. */
  value: z.string().max(2000).optional(),
  text: z.string().max(2000).optional(),
  url: z.string().max(2000).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().finite().optional(),
  /** Set when the client must ask the human before continuing. */
  reason: z.string().max(500).optional(),
  /** Free-form result slot for `extract`. */
  confidence: z.number().min(0).max(1).optional(),
})
export type Action = z.infer<typeof ActionSchema>

export const ActionPlanSchema = z.object({
  schema_version: z.string().min(1),
  session_id: z.string().min(8),
  steps: z.array(ActionSchema).min(1),
  /** 0..1; below T2_ESCALATION_THRESHOLD the client may escalate. */
  confidence: z.number().min(0).max(1),
  /** Honest degradation signal (§9): model wants more context. */
  needs_more_context: z.array(z.string().max(300)).default([]),
})
export type ActionPlan = z.infer<typeof ActionPlanSchema>

/* ------------------------------------------------------------------ *
 *  Request envelope (§4: three aligned artifacts, one request)
 * ------------------------------------------------------------------ */

export const PerceptionRequestSchema = z.object({
  schema_version: z.string().min(1),
  session_id: z.string().min(8),
  intent: z.string().max(2000),
  /** Null on the first turn of a task; set on turns 2..N. */
  turn: z.number().int().nonnegative().default(0),
  screen_state: ScreenStateSchema,
  redaction_manifest: RedactionManifestSchema,
  /** base64 WebP. Present unless turn > 0 and tiles were sent instead. */
  image_b64: z.string().optional(),
  /** Delta-tile upload (§7) for turns 2..N. */
  tiles: z
    .array(
      z.object({
        x: z.number().int(),
        y: z.number().int(),
        w: z.number().int().positive(),
        h: z.number().int().positive(),
        b64: z.string(),
      }),
    )
    .optional(),
  /** Client-side stage timings, ms. Reported, never trusted for scoring. */
  client_timings: z.record(z.number()).default({}),
  tier: z.enum(['T0', 'T1', 'T2']).default('T1'),
})
export type PerceptionRequest = z.infer<typeof PerceptionRequestSchema>

/* ------------------------------------------------------------------ *
 *  Gate verdict (§6.3)
 * ------------------------------------------------------------------ */

export const GateVerdictSchema = z.object({
  ok: z.boolean(),
  reasons: z.array(z.string()),
  /** Items the gate believes are covered. */
  covered: z.number().int().nonnegative(),
  /** Items classified but left unmasked. Must be 0 to pass. */
  uncovered: z.number().int().nonnegative(),
  frame_hash: z.string().regex(/^[0-9a-f]{16,64}$/),
})
export type GateVerdict = z.infer<typeof GateVerdictSchema>

/* ------------------------------------------------------------------ *
 *  Parsing helpers — every boundary goes through these. They throw with a
 *  useful message rather than returning a half-valid object.
 * ------------------------------------------------------------------ */

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown, where: string): z.infer<T> {
  const res = schema.safeParse(data)
  if (!res.success) {
    const first = res.error.issues[0]
    throw new Error(
      `[schema:${where}] ${first?.path.join('.') || '<root>'}: ${first?.message ?? 'validation failed'}`,
    )
  }
  return res.data
}

export const parseScreenState = (d: unknown) => parseOrThrow(ScreenStateSchema, d, 'screen_state')
export const parseManifest = (d: unknown) => parseOrThrow(RedactionManifestSchema, d, 'manifest')
export const parseActionPlan = (d: unknown) => parseOrThrow(ActionPlanSchema, d, 'action_plan')
export const parseRequest = (d: unknown) => parseOrThrow(PerceptionRequestSchema, d, 'perception_request')
export const parseGateVerdict = (d: unknown) => parseOrThrow(GateVerdictSchema, d, 'gate')
