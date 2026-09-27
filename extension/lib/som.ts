/**
 * Set-of-Mark: badge injection + mark→node resolution — ARCHITECTURE.md §4.
 * Marks are re-derived every cycle and resolved to nodes at *execution* time,
 * which is what makes a plan survive a DOM re-render.
 *
 * Pure logic lives here; the DOM work is behind narrow interfaces so the
 * selection/assignment algorithm is unit-testable in node.
 */

export interface MarkCandidate {
  /** Stable-per-cycle node handle (path-based, not a live reference). */
  nodeId: string
  role: string
  label: string
  box: { x: number; y: number; w: number; h: number }
  actions: readonly string[]
  /** Disabled / aria-hidden / offscreen elements get no mark. */
  eligible: boolean
  /** Larger interactive elements win ties — they are what users mean. */
  area?: number
}

export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'slider',
  'file',
])

/** Roles that are interactive but tiny — worth a mark, ranked low. */
const LOW_PRIORITY = new Set(['link', 'option', 'tab', 'menuitem'])

export function isInteractive(role: string): boolean {
  return INTERACTIVE_ROLES.has(role)
}

/**
 * Reading order = top-to-bottom, then left-to-right, with rows grouped so a
 * 20-item sidebar list reads as a column rather than an interleaved mess.
 */
export function readingOrder(cands: readonly MarkCandidate[]): MarkCandidate[] {
  return [...cands]
    .filter((c) => c.eligible && isInteractive(c.role))
    .sort((a, b) => {
      if (Math.abs(a.box.y - b.box.y) > 12) return a.box.y - b.box.y
      return a.box.x - b.box.x
    })
    .sort((a, b) => {
      // Stable sort in JS preserves the previous comparison, so do a two-key
      // pass explicitly: coarse row band, then x.
      const band = 24
      const ba = Math.floor(a.box.y / band)
      const bb = Math.floor(b.box.y / band)
      if (ba !== bb) return ba - bb
      return a.box.x - b.box.x
    })
}

export interface MarkAssignment {
  mark: number
  nodeId: string
  role: string
  label: string
  box: { x: number; y: number; w: number; h: number }
  priority: number
}

/**
 * Assign 1-based marks in reading order. Marks start at 1 because 0 means
 * "no mark" throughout the schema.
 */
export function assignMarks(cands: readonly MarkCandidate[]): MarkAssignment[] {
  return readingOrder(cands).map((c, i) => ({
    mark: i + 1,
    nodeId: c.nodeId,
    role: c.role,
    label: c.label.slice(0, 80),
    box: c.box,
    priority: priorityOf(c),
  }))
}

function priorityOf(c: MarkCandidate): number {
  const area = c.area ?? c.box.w * c.box.h
  const base = c.role === 'button' ? 60 : isInteractive(c.role) ? 40 : 20
  const sizeBonus = Math.min(20, Math.round(Math.log2(Math.max(1, area)) * 2))
  return base + sizeBonus - (LOW_PRIORITY.has(c.role) ? 15 : 0)
}

/* ================================================================== *
 *  mark → node resolution at execution time
 * ================================================================== */

export type ResolverStatus = 'ok' | 'reassigned' | 'lost'

export interface Resolution {
  status: ResolverStatus
  nodeId: string
  /** 0..1 confidence, drives the ask_user fallback (§12 risk table). */
  confidence: number
}

function normLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim()
}

function tokens(s: string): string[] {
  return normLabel(s).split(' ').filter((t) => t.length > 1)
}

/** Jaccard over word tokens — cheap, no embeddings, no network. */
export function labelSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 || tb.size === 0) return a === b ? 1 : 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

const REROLL_ACCEPT = 0.55
const REROLL_REQUIRE = 0.34

/**
 * Resolve a mark emitted by the server to a live node. Never throws, never
 * returns null: a lost target degrades to `lost` and the caller emits
 * `ask_user` rather than clicking a blind pixel (§12).
 */
export function resolveMark(
  mark: number,
  assignments: readonly MarkAssignment[],
  liveCandidates: readonly MarkCandidate[],
): Resolution {
  const exact = assignments.find((a) => a.mark === mark)
  if (!exact) {
    // The mark itself is gone (re-render). Fall back to the best label match
    // across all current interactive nodes.
    if (liveCandidates.length === 0) return { status: 'lost', nodeId: '', confidence: 0 }
    const best = bestByLabel('', liveCandidates)
    if (best && best.score >= REROLL_REQUIRE) {
      return { status: 'reassigned', nodeId: best.c.nodeId, confidence: best.score }
    }
    return { status: 'lost', nodeId: '', confidence: 0 }
  }

  const live = liveCandidates.find((c) => c.nodeId === exact.nodeId)
  if (live && live.eligible) {
    // Same node still there: verify it is still the same thing.
    const sim = labelSimilarity(exact.label, live.label)
    if (sim >= 0.99) return { status: 'ok', nodeId: live.nodeId, confidence: 1 }
    if (sim >= REROLL_ACCEPT) return { status: 'ok', nodeId: live.nodeId, confidence: sim }
    const alt = bestByLabel(exact.label, liveCandidates, exact.nodeId)
    if (alt && alt.score >= REROLL_REQUIRE) {
      return { status: 'reassigned', nodeId: alt.c.nodeId, confidence: alt.score }
    }
    return { status: 'lost', nodeId: '', confidence: sim }
  }

  const alt = bestByLabel(exact.label, liveCandidates, exact.nodeId)
  if (alt && alt.score >= REROLL_ACCEPT) {
    return { status: 'reassigned', nodeId: alt.c.nodeId, confidence: alt.score }
  }
  return { status: 'lost', nodeId: '', confidence: 0 }
}

function bestByLabel(
  label: string,
  cands: readonly MarkCandidate[],
  excludeNodeId?: string,
): { c: MarkCandidate; score: number } | null {
  let best: { c: MarkCandidate; score: number } | null = null
  for (const c of cands) {
    if (!c.eligible || c.nodeId === excludeNodeId) continue
    const score = labelSimilarity(label, c.label)
    if (!best || score > best.score) best = { c, score }
  }
  return best
}

/* ================================================================== *
 *  Badge drawing (used by the GPU compositor and by the overlay renderer)
 * ================================================================== */

/** Badge geometry for a mark: a filled square pinned to the element's top-left. */
export function badgeRect(
  box: { x: number; y: number; w: number; h: number },
  scale: number,
  size = 22,
): { x: number; y: number; w: number; h: number } {
  const s = size * scale
  return {
    x: Math.max(0, box.x - s * 0.35),
    y: Math.max(0, box.y - s * 0.35),
    w: s,
    h: s,
  }
}
