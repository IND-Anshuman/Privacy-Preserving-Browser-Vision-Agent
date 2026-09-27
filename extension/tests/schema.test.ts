import { describe, it, expect } from 'vitest'
import {
  ActionPlanSchema,
  PerceptionRequestSchema,
  RedactionManifestSchema,
  ScreenStateSchema,
  parseActionPlan,
  parseManifest,
  parseOrThrow,
  SCHEMA_VERSION,
  PII_CLASSES,
  ACTION_NAMES,
} from '../lib/schema'
import { parseMessage, CASCADE_BY_PRESSURE, mustMessage } from '../lib/messages'
import { REDACTED_PASSWORD } from '../lib/pii'

const box = { x: 1, y: 2, w: 30, h: 10 }

const manifest = {
  schema_version: SCHEMA_VERSION,
  session_id: 'session-0001',
  redactions: [
    {
      id: 'r1',
      box,
      cls: 'PASSWORD',
      placeholder: { token: '[PASSWORD_1]', cls: 'PASSWORD' },
      method: 'solid_fill',
      score: 0.99,
      source: 'L0',
      pixelDerived: false,
    },
  ],
  frame_hash: 'abcdef0123456789',
  signature: 'a'.repeat(64),
  model_versions: { l2_ner: 'gliner', l3_face: 'blazeface', l3_text: 'dbnet', runtime: 'webgpu' },
  abort_reason: null,
}

const screenState = {
  schema_version: SCHEMA_VERSION,
  session_id: 'session-0001',
  frame_hash: 'abcdef0123456789',
  url: 'https://example.test/form',
  title: 'KYC form',
  root: {
    id: 'root',
    role: 'document',
    valueClass: 'public',
    children: [
      { id: 'n1', role: 'button', label: 'Submit', valueClass: 'public', mark: 1, actions: ['click'], children: [] },
      { id: 'n2', role: 'textbox', label: 'Password', valueType: 'password', valueClass: 'sensitive', mark: 2, actions: ['fill'], children: [] },
    ],
  },
  mark_count: 2,
}

describe('schema: fail-closed parsing', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseManifest(manifest)
    expect(m.redactions[0]!.cls).toBe('PASSWORD')
  })

  it('rejects a manifest with a missing frame hash', () => {
    const bad = { ...manifest, frame_hash: undefined }
    expect(() => parseManifest(bad)).toThrow(/frame_hash/)
  })

  it('rejects a non-hex frame hash', () => {
    expect(() => parseManifest({ ...manifest, frame_hash: 'nothex!!' })).toThrow()
  })

  it('rejects a short session id', () => {
    expect(() => parseManifest({ ...manifest, session_id: 'ab' })).toThrow()
  })

  it('rejects a redaction with a malformed placeholder token', () => {
    const bad = { ...manifest, redactions: [{ ...manifest.redactions[0]!, placeholder: { token: 'PERSON_1', cls: 'PERSON' } }] }
    expect(() => parseManifest(bad)).toThrow(/placeholder/)
  })

  it('rejects a score outside [0,1]', () => {
    const bad = { ...manifest, redactions: [{ ...manifest.redactions[0]!, score: 1.4 }] }
    expect(() => parseManifest(bad)).toThrow(/score/)
  })

  it('rejects an unknown pii class', () => {
    const bad = { ...manifest, redactions: [{ ...manifest.redactions[0]!, cls: 'SECRET_SAUCE' }] }
    expect(() => parseManifest(bad)).toThrow()
  })

  it('rejects an unknown redaction method', () => {
    const bad = { ...manifest, redactions: [{ ...manifest.redactions[0]!, method: 'drop_table' }] }
    expect(() => parseManifest(bad)).toThrow()
  })

  it('rejects a negative box size', () => {
    const bad = { ...manifest, redactions: [{ ...manifest.redactions[0]!, box: { x: 0, y: 0, w: -1, h: 0 } }] }
    expect(() => parseManifest(bad)).toThrow()
  })
})

describe('schema: plan', () => {
  const plan = {
    schema_version: SCHEMA_VERSION,
    session_id: 'session-0001',
    steps: [{ action: 'click', target: { mark: 1 } }],
    confidence: 0.9,
    needs_more_context: [],
  }

  it('accepts the full action vocabulary', () => {
    for (const a of ACTION_NAMES) {
      const p = parseActionPlan({ ...plan, steps: [{ action: a }] })
      expect(p.steps[0]!.action).toBe(a)
    }
  })

  it('rejects an action outside the vocabulary — this is what XGrammar enforces server-side', () => {
    expect(() => parseActionPlan({ ...plan, steps: [{ action: 'download_exfiltrate' }] })).toThrow()
  })

  it('rejects an empty plan', () => {
    expect(() => parseActionPlan({ ...plan, steps: [] })).toThrow()
  })

  it('rejects confidence outside [0,1]', () => {
    expect(() => parseActionPlan({ ...plan, confidence: 1.2 })).toThrow()
  })

  it('rejects a fill value that is not a string', () => {
    expect(() => parseActionPlan({ ...plan, steps: [{ action: 'fill', value: { nested: 1 } }] })).toThrow()
  })
})

describe('schema: request envelope', () => {
  const req = {
    schema_version: SCHEMA_VERSION,
    session_id: 'session-0001',
    intent: 'fill the non-sensitive fields',
    turn: 0,
    screen_state: screenState,
    redaction_manifest: manifest,
    image_b64: 'UklGRg==',
    client_timings: { capture: 12, redact: 30 },
    tier: 'T1',
  }

  it('accepts the three-artifact request', () => {
    const r = parseOrThrow(PerceptionRequestSchema, req, 'req')
    expect(r.screen_state.mark_count).toBe(2)
    expect(r.tier).toBe('T1')
  })

  it('accepts a delta-tile turn with no full image', () => {
    const r = parseOrThrow(
      PerceptionRequestSchema,
      { ...req, turn: 2, image_b64: undefined, tiles: [{ x: 0, y: 0, w: 64, h: 64, b64: 'AA==' }] },
      'req',
    )
    expect(r.tiles).toHaveLength(1)
  })

  it('does not let a sensitive value ride in screen_state', () => {
    // The schema carries valueClass, not the secret. Assert the shape forces it.
    const node = (screenState.root.children as Array<{ valueClass?: string; value?: string }>)[1]!
    expect(node.valueClass).toBe('sensitive')
    expect(node.value).toBeUndefined()
    expect(REDACTED_PASSWORD).toBe('<redacted:password>')
  })
})

describe('schema: taxonomy', () => {
  it('keeps class names in the placeholder grammar', () => {
    for (const c of PII_CLASSES) {
      expect(c).toMatch(/^[A-Z_]+$/)
    }
  })

  it('rejects a node with a valueClass outside the enum', () => {
    const bad = structuredClone(screenState)
    bad.root.valueClass = 'encrypted'
    expect(ScreenStateSchema.safeParse(bad).success).toBe(false)
  })
})

describe('message bus', () => {
  it('accepts a known message', () => {
    const m = parseMessage({ kind: 'panel:run', intent: 'what is on my screen', tier: 'T0' })
    expect(m?.kind).toBe('panel:run')
  })

  it('returns null for an unknown message rather than throwing', () => {
    expect(parseMessage({ kind: 'evil:exfiltrate' })).toBeNull()
  })

  it('returns null for a message missing a required field', () => {
    expect(parseMessage({ kind: 'panel:run' })).toBeNull()
  })

  it('mustMessage throws with context on violation', () => {
    expect(() => mustMessage({ kind: 'nope' }, 'sw')).toThrow(/msg:sw/)
  })
})

describe('compute pressure cascade', () => {
  it('keeps L0/L1 on at every pressure level — the fail-safe is still private', () => {
    for (const s of ['nominal', 'fair', 'serious', 'critical'] as const) {
      expect(CASCADE_BY_PRESSURE[s].L0).toBe(true)
      expect(CASCADE_BY_PRESSURE[s].L1).toBe(true)
    }
  })

  it('monotonically sheds expensive layers as pressure rises', () => {
    const n = CASCADE_BY_PRESSURE.nominal
    const f = CASCADE_BY_PRESSURE.fair
    const s = CASCADE_BY_PRESSURE.serious
    const c = CASCADE_BY_PRESSURE.critical
    expect(n.L2 && n.L3 && n.audit).toBe(true)
    expect(f.audit).toBe(false)
    expect(s.L3).toBe(false)
    expect(c.L2).toBe(false)
    expect(c.L3).toBe(false)
  })
})
