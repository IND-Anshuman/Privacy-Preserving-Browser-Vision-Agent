/**
 * Content script — the DOM channel. ARCHITECTURE.md §2, §4, §5.
 *
 * Runs in the page but talks to the SW over runtime messaging only. It never
 * touches the network itself, and it never returns a raw sensitive value
 * across the message boundary: values leave as placeholders.
 */
import { defineContentScript } from 'wxt/sandbox'
import { parseMessage, type VeilMessage } from '@/lib/messages'
import {
  SCHEMA_VERSION,
  type OpaqueFrame,
  type PiiClass,
  type ScreenNode,
  type ValueClass,
} from '@/lib/schema'
import { classifySemantics, hitsFromElement, runL1, REDACTED_PASSWORD, type RawHit } from '@/lib/pii'
import { assignMarks, resolveMark, type MarkAssignment, type MarkCandidate } from '@/lib/som'
import { decideSafety } from '@/lib/action-safety'
import { Pseudonymizer } from '@/lib/pseudonym'
import { fnv1a } from '@/lib/framediff'

/* ------------------------------------------------------------------ *
 *  Per-frame state
 * ------------------------------------------------------------------ */

let currentMarks: MarkAssignment[] = []
let overlay: HTMLDivElement | null = null
/**
 * One pseudonymizer per session, shared by the DOM channel. It MUST be the
 * same salt space the compositor uses, or a value would get two different
 * tokens in screen_state.json and the manifest and co-reference would break.
 */
let pseudo: Pseudonymizer | null = null
const MAX_DEPTH = 8
const MAX_CHILDREN = 40

function pseudonyms(sessionId: string): Pseudonymizer {
  if (!pseudo) pseudo = new Pseudonymizer(sessionId)
  return pseudo
}

/* ------------------------------------------------------------------ *
 *  DOM walking
 * ------------------------------------------------------------------ */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK'])
const SKIP_CLASS = /(^|[-_\s])(veil-|sr-only|visually-hidden)([-_\s]|$)/

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria.trim()
  const labelledby = el.getAttribute('aria-labelledby')
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
    if (parts.length) return parts.join(' ')
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const lbl = el.labels?.[0]?.textContent?.trim()
    if (lbl) return lbl
    // HTMLSelectElement has no placeholder attribute.
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return el.placeholder.trim()
    }
    if (el.title) return el.title.trim()
  }
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= 80 ? text : text.slice(0, 80)
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'button': return 'button'
    case 'a': return el.hasAttribute('href') ? 'link' : 'generic'
    case 'input': {
      const t = (el as HTMLInputElement).type.toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button'
      if (t === 'range') return 'slider'
      if (t === 'file') return 'file'
      if (t === 'search') return 'searchbox'
      return 'textbox'
    }
    case 'textarea': return 'textbox'
    case 'select': return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    case 'img': return 'img'
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading'
    case 'form': return 'form'
    case 'nav': return 'navigation'
    case 'main': return 'main'
    case 'table': return 'table'
    case 'tr': return 'row'
    case 'td': case 'th': return 'cell'
    case 'ul': case 'ol': return 'list'
    case 'li': return 'listitem'
    default: return tag
  }
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return false
  const cs = getComputedStyle(el)
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  return true
}

function actionsFor(role: string, el: Element): Array<'click' | 'fill' | 'focus' | 'scroll' | 'hover' | 'select'> {
  switch (role) {
    case 'button': return ['click', 'hover']
    case 'link': return ['click']
    case 'textbox': return ['fill', 'focus', 'click']
    case 'searchbox': return ['fill', 'click']
    case 'combobox': return ['select', 'click']
    case 'listbox': return ['select', 'click']
    case 'checkbox':
    case 'radio':
    case 'switch': return ['click']
    case 'slider':
    case 'spinbutton': return ['fill', 'click']
    default: return []
  }
}

/** Stable per-cycle handle: a path of child indices, not a live node ref. */
function nodeHandle(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur !== document.body && parts.length < 12) {
    const parent: Element | null = cur.parentElement
    if (!parent) break
    const idx = Array.prototype.indexOf.call(parent.children, cur)
    parts.unshift(String(idx))
    cur = parent
  }
  return parts.join('/') || 'root'
}

/* ------------------------------------------------------------------ *
 *  L0/L1 classification over the live DOM
 * ------------------------------------------------------------------ */

function dataAttrsOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of el.attributes) {
    if (a.name.startsWith('data-') && a.value) out[a.name] = a.value
  }
  return out
}

export function classifyElement(el: Element): RawHit[] {
  const v = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : undefined
  const box = rectOf(el)
  const like = {
    tag: el.tagName.toLowerCase(),
    type: el instanceof HTMLInputElement ? el.type : undefined,
    id: el.id || undefined,
    name: el.getAttribute('name') ?? undefined,
    placeholder: el.getAttribute('placeholder') ?? undefined,
    ariaLabel: el.getAttribute('aria-label') ?? undefined,
    title: el.getAttribute('title') ?? undefined,
    alt: el.getAttribute('alt') ?? undefined,
    autocomplete: el.getAttribute('autocomplete') ?? undefined,
    value: v,
    contentEditable: (el as HTMLElement).isContentEditable,
    dataAttrs: dataAttrsOf(el),
    box,
    nodeId: nodeHandle(el),
  }
  const hits = hitsFromElement(like)
  // Free text in text-bearing elements goes through L1 too.
  if (el.textContent && el.children.length === 0) {
    for (const h of runL1(el.textContent)) {
      hits.push({ ...h, box, nodeId: nodeHandle(el) })
    }
  }
  return hits
}

/**
 * Is this element a host whose shadow tree we cannot read?
 *
 * There is no API that answers this. `attachShadow({mode:'closed'})` is
 * deliberately opaque by design, and `el.shadowRoot` is null for both "no
 * shadow at all" and "sealed shadow". The only observable difference is that a
 * sealed host PAINTS its shadow content while exposing no children, so:
 *
 *   - it has no open shadowRoot,
 *   - it has no light children, and
 *   - it occupies real space on screen.
 *
 * The test is therefore a heuristic, and the honest cost is stated: a custom
 * element that renders itself into its own shadow tree — a web component, which
 * is exactly the case we care about — is blanked; a plain styled <div> is not.
 * The alternative, guessing, is what produced the 0/4 the audit found.
 */
function isSealedShadowHost(el: Element): boolean {
  if ((el as Element & { shadowRoot?: unknown }).shadowRoot) return false
  if (el.children.length > 0) return false
  // A custom element is the overwhelmingly common sealed host. Tag names with a
  // dash are the only way to identify one from outside the component.
  if (!el.tagName.includes('-')) return false
  const r = el.getBoundingClientRect()
  if (r.width < 8 || r.height < 8) return false
  // And it must actually paint something: a bare unstyled custom element with no
  // box-shadow/background renders nothing, so blanking it is pure noise.
  const cs = getComputedStyle(el)
  if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false
  return true
}

/**
 * Viewport coordinates — the space the compositor draws in.
 *
 * This was `r.left + scrollX` (DOCUMENT space) and it was a real bug: the
 * captured frame is a viewport, so on a page scrolled by S every redaction box
 * was displaced by +S in y. The password field stayed visible and a harmless
 * region got blacked out. The synthetic corpus never scrolls, so the benchmark
 * could not see it — but a real demo hits it within seconds.
 */
function rectOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

/** Document coordinates, for the DOM channel only. Never for a redaction box. */
function documentRectOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
}

/**
 * Redact an accessible name before it is allowed to leave the page.
 *
 * This closes the §1.1 leak. `label` used to be raw `textContent`, so a
 * person's name or email was POSTed to the server inside screen_state.json,
 * with `valueClass: 'sensitive'` — which is metadata ABOUT a value, not a
 * substitute for it — sitting next to it looking like protection.
 *
 * Structure is preserved: "Applicant: [PERSON_1] filed under [AADHAAR_1]" still
 * tells the server everything it needs about the page's shape.
 */
function redactName(name: string, hits: RawHit[], sessionId: string): string {
  if (!name) return name
  const p = pseudonyms(sessionId)
  const spans: Array<{ start: number; end: number; cls: PiiClass; text: string }> = []
  for (const h of hits) {
    if (h.cls !== 'PASSWORD' && h.score < 0.5) continue
    const needle = h.text
    if (!needle || needle.length < 2) continue
    const at = name.indexOf(needle)
    if (at < 0) continue
    spans.push({ start: at, end: at + needle.length, cls: h.cls, text: needle })
  }
  return p.substitute(name, spans)
}

/* ------------------------------------------------------------------ *
 *  Snapshot + pruning (§4)
 * ------------------------------------------------------------------ */

function buildSnapshot(
  runId: string,
): { state: unknown; detections: RawHit[]; frameHash: string; marks: MarkAssignment[] } {
  const candidates: MarkCandidate[] = []
  const detections: RawHit[] = []
  /**
   * Structural fingerprint of the emitted tree. This is a real value, not a
   * placeholder: the old literal 'pending' failed /^[0-9a-f]{16,64}$/ and so
   * every T1 run threw in ScreenStateSchema.parse before a frame was captured.
   */
  const fingerprint: string[] = []
  let markSeq = 0

  const walk = (el: Element, depth: number): ScreenNode | null => {
    if (depth > MAX_DEPTH) return null
    if (SKIP_TAGS.has(el.tagName)) return null
    if (SKIP_CLASS.test(el.className?.toString() ?? '')) return null
    if (!isVisible(el)) return null

    const role = roleOf(el)
    const rawName = accessibleName(el)
    const nodeId = nodeHandle(el)
    const hits = classifyElement(el)
    detections.push(...hits)

    // Redact BEFORE the name is used anywhere. Both the emitted `label` and the
    // mark candidate must carry the token, or the server sees one and the
    // on-page overlay shows the other.
    const name = redactName(rawName, hits, runId)

    const sensitive = hits.some((h) => h.cls === 'PASSWORD' || h.score >= 0.6)

    /**
     * `valueClass` is a three-way statement, and the third value was
     * unreachable: every node was `sensitive` or `masked`, so `public` only
     * appeared in a root fallback that never fires in practice. That matters
     * because the server prompt is built from this field — a node labelled
     * `masked` reads as "something was redacted here", and sending that for
     * every static paragraph makes the manifest meaningless.
     *
     *   sensitive — a detection fired; the value is redacted or pseudonymized
     *   public    — positively known to carry no personal data
     *   masked    — a placeholder stands in for something, class unknown
     */
    const valueClass: ValueClass = sensitive
      ? 'sensitive'
      : name && /\[[A-Z]+_[A-Z0-9]*_?\d+\]/.test(name)
        ? 'masked'
        : 'public'

    const actions = actionsFor(role, el)
    const interactive = actions.length > 0

    let mark: number | undefined
    if (interactive) {
      markSeq += 1
      mark = markSeq
      candidates.push({
        nodeId,
        role,
        label: name,
        box: rectOf(el),
        actions,
        eligible: true,
        area: (el as HTMLElement).offsetWidth * (el as HTMLElement).offsetHeight,
      })
    }

    // Prune: a node with no accessible name and no role/action is noise.
    if (!interactive && !name && el.children.length > 0) return null

    const children: ScreenNode[] = []
    let childCount = 0
    for (const child of Array.from(el.children)) {
      if (childCount >= MAX_CHILDREN) break
      const built = walk(child, depth + 1)
      if (built) {
        children.push(built)
        childCount += 1
      }
    }

    /**
     * §5 shadow DOM. `el.children` does not cross a shadow boundary, so a value
     * inside a custom element was invisible to this walk — the shadow channel
     * scored 0/4 and nothing in the code even referenced `shadowRoot`.
     *
     * An OPEN root is traversable: `shadowRoot` is non-null, and we descend
     * exactly as we would into a light child. A CLOSED root returns null for
     * the same property, so "no shadow" and "sealed shadow" are
     * indistinguishable from the host alone. The only reliable discriminator is
     * observable behaviour: a sealed host paints content that `el.children`
     * does not contain. So a host with a non-trivial painted box, no open
     * root, and no light children is treated as sealed and FAIL-CLOSED — its
     * rect becomes an OPAQUE_REGION and the compositor blanks it.
     *
     * Over-blanking a sealed host costs a useless box. Under-blanking it ships
     * whatever a component author decided to render, which is the entire class
     * of attack this project exists to stop.
     */
    const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot
    if (shadow) {
      for (const child of Array.from(shadow.children)) {
        if (childCount >= MAX_CHILDREN) break
        const built = walk(child, depth + 1)
        if (built) {
          children.push(built)
          childCount += 1
        }
      }
    } else if (isSealedShadowHost(el)) {
      const r = rectOf(el)
      if (r.w >= 8 && r.h >= 8) {
        detections.push({
          cls: 'OPAQUE_REGION',
          text: '',
          score: 1,
          start: 0,
          end: 0,
          source: 'L0',
          box: r,
        })
        // The host's contents are not enumerable, so its light children were
        // already walked above; there is nothing further to descend into.
        void walk
      }
    }

    // Collapse repeated rows (§4) — keeps a 200-row table from eating the budget.
    const deduped = collapseRepeats(children)

    // The fingerprint hashes the REDACTED structure, so a typed value cannot
    // leak into it, and it changes when a control appears or disappears.
    // [1.3] It must key on the CLASS, not a count: typing a name into a field
    // changes the pseudonym but not how many detections there are, and a
    // count-based gate would ship a stale manifest over new PII.
    fingerprint.push(`${role}|${name}|${valueClass}|${mark ?? -1}|${actions.join(',')}`)

    return {
      id: nodeId,
      role,
      ...(name ? { label: name } : {}),
      valueType: valueTypeOf(el),
      // A sensitive value NEVER gets a `value` field. [schema contract]
      valueClass,
      bbox: documentRectOf(el),
      ...(mark !== undefined ? { mark } : {}),
      actions,
      children: deduped,
    }
  }

  const body = document.body
  const root = body ? walk(body, 0) : { id: 'root', role: 'document', valueClass: 'public' as ValueClass, children: [] }

  const marks = assignMarks(candidates)
  currentMarks = marks

  // 16 hex chars satisfies the schema's /^[0-9a-f]{16,64}$/ and is derived
  // from the real structure, so it is stable across re-snapshots of one page.
  const frameHash = fnv1a(fingerprint.join('\n')).padEnd(16, '0')

  return {
    state: {
      schema_version: SCHEMA_VERSION,
      session_id: runId,
      frame_hash: frameHash,
      url: location.href.slice(0, 2000),
      title: document.title.slice(0, 300),
      root,
      mark_count: marks.length,
    },
    detections,
    frameHash,
    /** Marks are returned so the SW can pass them to the compositor (fix 1.5). */
    marks: currentMarks,
  }
}

function valueTypeOf(el: Element): string {
  if (el instanceof HTMLInputElement) {
    const t = el.type.toLowerCase()
    if (t === 'password') return 'password'
    if (t === 'email') return 'email'
    if (t === 'tel') return 'tel'
    if (t === 'number') return 'number'
    if (t === 'checkbox' || t === 'radio') return 'checkbox'
    return 'text'
  }
  if (el instanceof HTMLTextAreaElement) return 'text'
  if (el instanceof HTMLSelectElement) return 'select'
  if ((el as HTMLElement).isContentEditable) return 'text'
  return 'none'
}

/** Keep the first of each (role,label) run and record that it repeats. */
function collapseRepeats(nodes: ScreenNode[]): ScreenNode[] {
  const out: ScreenNode[] = []
  const seen = new Map<string, ScreenNode>()
  for (const n of nodes) {
    const key = `${n.role}|${(n.label ?? '').slice(0, 30)}`
    const prev = seen.get(key)
    if (prev) {
      prev.children = (prev.children ?? []).slice(0, 2)
      continue
    }
    seen.set(key, n)
    out.push(n)
  }
  return out
}

/* ------------------------------------------------------------------ *
 *  SoM overlay (§4)
 * ------------------------------------------------------------------ */

function showOverlay(marks: MarkAssignment[]): void {
  hideOverlay()
  const layer = document.createElement('div')
  layer.id = 'veil-som-layer'
  layer.style.cssText = 'position:absolute;inset:0;z-index:2147483646;pointer-events:none;'
  for (const m of marks) {
    const b = document.createElement('div')
    b.textContent = String(m.mark)
    b.style.cssText = `position:absolute;left:${m.box.x}px;top:${m.box.y}px;transform:translate(-30%,-30%);
      background:#1d4ed8;color:#fff;border:1.5px solid #fff;border-radius:4px;
      font:600 12px/16px system-ui,sans-serif;min-width:18px;height:18px;text-align:center;`
    layer.appendChild(b)
  }
  document.body.appendChild(layer)
  overlay = layer
}

function hideOverlay(): void {
  overlay?.remove()
  overlay = null
}

/* ------------------------------------------------------------------ *
 *  Executor (§4) — mark re-resolution + destructive confirmation
 * ------------------------------------------------------------------ */


interface PlanAction {
  action: string
  target?: { mark?: number; selector?: string; role?: string; name?: string }
  value?: string
  text?: string
  url?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
}

function liveCandidates(): MarkCandidate[] {
  const out: MarkCandidate[] = []
  for (const el of document.querySelectorAll<HTMLElement>('input,button,a,select,textarea,[role]')) {
    if (!isVisible(el)) continue
    const role = roleOf(el)
    if (actionsFor(role, el).length === 0) continue
    out.push({
      nodeId: nodeHandle(el),
      role,
      label: accessibleName(el),
      box: rectOf(el),
      actions: actionsFor(role, el),
      eligible: true,
    })
  }
  return out
}

function byHandle(nodeId: string): HTMLElement | null {
  const parts = nodeId.split('/').map(Number)
  let cur: Element | null = document.body
  for (const idx of parts) {
    if (!cur) return null
    cur = cur.children[idx] ?? null
  }
  return cur instanceof HTMLElement ? cur : null
}

async function executeAction(runId: string, index: number, act: PlanAction): Promise<unknown> {
  const t0 = performance.now()

  // Re-resolve the mark against the LIVE page, not the stale snapshot.
  let el: HTMLElement | null = null
  let rerolled = false
  if (act.target?.mark !== undefined) {
    const res = resolveMark(act.target.mark, currentMarks, liveCandidates())
    if (res.status === 'lost' || !res.nodeId) {
      // Never a blind click. Ask instead (§12 risk table).
      return confirmToast('That control is no longer on the page. Continue?', runId, index)
    }
    rerolled = res.status === 'reassigned'
    el = byHandle(res.nodeId)
    if (!el) return confirmToast('That control could not be found. Continue?', runId, index)
  } else if (act.target?.selector) {
    el = document.querySelector<HTMLElement>(act.target.selector)
  }

  const verb = (el?.tagName.toLowerCase() === 'button' ? el.textContent?.trim() ?? '' : '') + ' ' + accessibleName(el ?? document.body)

  /**
   * One policy, one place. The destructive-verb check, the fill guard and the
   * reroll guard all used to live inline here, which is how `click` and `focus`
   * ended up unguarded: the sensitive-target check was inside the `fill` case.
   * `decideSafety` evaluates every axis for every action.
   */
  const safety = decideSafety({
    action: act.action,
    verb,
    rerolled,
    targetSensitive: el ? isSensitiveTarget(el) : false,
  })
  if (safety.confirm) {
    return confirmToast(safety.reason ?? 'Continue?', runId, index)
  }

  switch (act.action) {
    case 'click':
      el?.click()
      break
    case 'focus':
      el?.focus()
      break
    case 'hover':
      el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      break
    case 'fill': {
      if (!el) break
      // The sensitive-target guard for `fill` now lives in decideSafety, so it
      // runs for every action instead of only this one.
      const value = act.value ?? ''
      setNativeValue(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      break
    }
    case 'select': {
      if (el instanceof HTMLSelectElement && act.value) {
        el.value = act.value
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      break
    }
    case 'scroll':
      window.scrollBy({
        top: act.direction === 'up' ? -(act.amount ?? 400) : act.amount ?? 400,
        behavior: 'smooth',
      })
      break
    case 'navigate':
      if (act.url) location.href = act.url
      break
    case 'wait_for':
      await new Promise((r) => setTimeout(r, Math.min(2000, act.amount ?? 200)))
      break
    case 'none':
    case 'ask_user':
      break
    default:
      break
  }

  return { ok: true, status: act.action, ms: performance.now() - t0 }
}

function isSensitiveTarget(el: HTMLElement): boolean {
  const like = {
    tag: el.tagName.toLowerCase(),
    type: el instanceof HTMLInputElement ? el.type : undefined,
    id: el.id || undefined,
    name: el.getAttribute('name') ?? undefined,
    placeholder: el.getAttribute('placeholder') ?? undefined,
    ariaLabel: el.getAttribute('aria-label') ?? undefined,
    autocomplete: el.getAttribute('autocomplete') ?? undefined,
  }
  const v = classifySemantics(like)
  return v.cls === 'PASSWORD' || v.isPassword
}

/** React and friends patch value setters; this is the reliable way to set one. */
function setNativeValue(el: HTMLElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as { value?: string }
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  if (desc?.set) desc.set.call(el, value)
  else (el as HTMLInputElement).value = value
}

function confirmToast(text: string, runId: string, index: number): unknown {
  return { ok: false, needsConfirm: true, reason: text, runId, actionIndex: index }
}

/* ------------------------------------------------------------------ *
 *  Message handling
 * ------------------------------------------------------------------ */

async function handle(msg: VeilMessage): Promise<unknown> {
  switch (msg.kind) {
    case 'content:snapshot': {
      // §5 hard case: cross-origin frames that refuse injection are treated as
      // FULLY SENSITIVE. This used to set a boolean that nothing downstream
      // read, so an uninspectable iframe was detected and then ignored — the
      // request went out with the frame's pixels intact.
      //
      // Fail-closed means: if we cannot see inside it, we cannot redact it, so
      // we do not send the region. Each such frame contributes a box covering
      // its viewport rect, and the compositor fills it.
      const opaqueFrames: OpaqueFrame[] = []
      for (const f of Array.from(document.querySelectorAll('iframe, frame, embed, object'))) {
        let inspectable = true
        try {
          // Reading contentDocument from another origin throws, and for a
          // same-origin frame the content script runs inside it too — in which
          // case it reports its own detections and the frame is not opaque.
          // `embed`/`object` have no contentDocument at all, so they are opaque
          // by construction rather than by exception.
          const framed = f as Element & { contentDocument?: Document | null }
          const d = 'contentDocument' in framed ? framed.contentDocument : null
          inspectable = d != null
        } catch {
          inspectable = false
        }
        // A frame we can read but that has no document of its own (srcdoc-less,
        // or blocked by CSP) is equally unredactable by us.
        if (!inspectable) {
          const r = f.getBoundingClientRect()
          // A zero-size frame contributes no pixels and cannot leak anything.
          if (r.width < 8 || r.height < 8) continue
          opaqueFrames.push({
            src: f.getAttribute('src') ?? f.getAttribute('data') ?? '(no src)',
            x: r.left, y: r.top, w: r.width, h: r.height,
          })
        }
      }

      const { state, detections, marks } = buildSnapshot(msg.runId)
      // The opaque-frame boxes go into the same detection list the compositor
      // already understands, so the fail-closed rule is enforced in one place
      // (the gate) rather than by a special case per call site.
      for (const f of opaqueFrames) {
        detections.push({
          cls: 'OPAQUE_REGION',
          text: '',
          score: 1,
          // A box has no text span, so the offsets are meaningless. Zero-width
          // is the honest encoding and the gate's degenerate check tolerates it
          // because it only tests the BOX, not the span.
          start: 0,
          end: 0,
          source: 'L0',
          box: { x: f.x, y: f.y, w: f.w, h: f.h },
        })
      }
      const live = currentMarks
      showOverlay(live)

      await chrome.runtime.sendMessage({
        kind: 'snapshot:ready',
        runId: msg.runId,
        screenState: state,
        rawDetections: detections,
        marks: live,
        crossOriginSuspect: opaqueFrames.length > 0,
        opaqueFrames,
      })
      return {
        ok: true,
        detections: detections.length,
        marks: live.length,
        opaqueFrames: opaqueFrames.length,
      }
    }
    case 'content:execute':
      return executeAction(msg.runId, 0, msg.action as PlanAction)
    case 'content:confirm': {
      // Previously this returned {ok:true, confirmed:true} without doing
      // anything, so a user who approved a destructive step still saw the
      // button un-pressed. The SW re-sends the action with `approved`, so the
      // real work happens in the execute path; here we simply clear the
      // on-page gate. [audit 3.1]
      if (msg.approved === false) return { ok: true, confirmed: false }
      return { ok: true, confirmed: true }
    }
    case 'content:teardown':
      hideOverlay()
      return { ok: true }
    default:
      return { ok: false, error: `unhandled ${msg.kind}` }
  }
}

/* ------------------------------------------------------------------ *
 *  Startup. WXT imports this module in Node during `prepare` to read its
 *  config, so NOTHING that touches the DOM or the chrome.* namespace may run
 *  at module scope. All wiring happens inside main(), which only ever executes
 *  in the page. The functions above are pure declarations.
 * ------------------------------------------------------------------ */

function start(): void {
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = parseMessage(raw)
    if (!msg) {
      sendResponse({ ok: false, error: 'invalid message' })
      return false
    }
    void handle(msg).then(sendResponse).catch((e: unknown) => {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
    })
    return true
  })

  // Re-scan on DOM mutation so an autofilled value is caught even though no
  // input event ever fired (§5 hard case). The observer only refreshes the
  // overlay; the next cycle re-reads value attributes regardless.
  let scanTimer: number | undefined
  const observer = new MutationObserver(() => {
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = window.setTimeout(() => {
      if (overlay) showOverlay(currentMarks)
    }, 400)
  })
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['value', 'type', 'name', 'id'],
    })
  }
}

/**
 * `matches: ['<all_urls>']` + `allFrames: true` is deliberate and load-bearing:
 * a cross-origin iframe is exactly the case §5 requires us to detect, and we
 * can only detect it if the script runs inside it. Frames that refuse
 * injection are reported as fully sensitive and redacted wholesale.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main: start,
})
