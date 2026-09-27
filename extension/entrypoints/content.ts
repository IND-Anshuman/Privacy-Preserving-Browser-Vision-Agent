/**
 * Content script — the DOM channel. ARCHITECTURE.md §2, §4, §5.
 *
 * Runs in the page but talks to the SW over runtime messaging only. It never
 * touches the network itself, and it never returns a raw sensitive value
 * across the message boundary: values leave as placeholders.
 */
import { defineContentScript } from 'wxt/sandbox'
import { parseMessage, type VeilMessage } from '@/lib/messages'
import { SCHEMA_VERSION, type PiiClass, type ScreenNode, type ValueClass } from '@/lib/schema'
import { classifySemantics, hitsFromElement, runL1, REDACTED_PASSWORD, type RawHit } from '@/lib/pii'
import { assignMarks, resolveMark, type MarkAssignment, type MarkCandidate } from '@/lib/som'

/* ------------------------------------------------------------------ *
 *  Per-frame state
 * ------------------------------------------------------------------ */

let currentMarks: MarkAssignment[] = []
let overlay: HTMLDivElement | null = null
const MAX_DEPTH = 8
const MAX_CHILDREN = 40

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

function rectOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
}

/* ------------------------------------------------------------------ *
 *  Snapshot + pruning (§4)
 * ------------------------------------------------------------------ */

function buildSnapshot(runId: string, frameHash: string): { state: unknown; detections: RawHit[] } {
  const candidates: MarkCandidate[] = []
  const detections: RawHit[] = []
  let markSeq = 0

  const walk = (el: Element, depth: number): ScreenNode | null => {
    if (depth > MAX_DEPTH) return null
    if (SKIP_TAGS.has(el.tagName)) return null
    if (SKIP_CLASS.test(el.className?.toString() ?? '')) return null
    if (!isVisible(el)) return null

    const role = roleOf(el)
    const name = accessibleName(el)
    const nodeId = nodeHandle(el)
    const hits = classifyElement(el)
    detections.push(...hits)

    const sensitive = hits.some((h) => h.cls === 'PASSWORD' || h.score >= 0.6)
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

    // Collapse repeated rows (§4) — keeps a 200-row table from eating the budget.
    const deduped = collapseRepeats(children)

    return {
      id: nodeId,
      role,
      ...(name ? { label: name } : {}),
      valueType: valueTypeOf(el),
      // A sensitive value NEVER gets a `value` field. [schema contract]
      valueClass: (sensitive ? 'sensitive' : 'masked') as ValueClass,
      bbox: rectOf(el),
      ...(mark !== undefined ? { mark } : {}),
      actions,
      children: deduped,
    }
  }

  const body = document.body
  const root = body ? walk(body, 0) : { id: 'root', role: 'document', valueClass: 'public' as ValueClass, children: [] }

  const marks = assignMarks(candidates)
  currentMarks = marks

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

const DESTRUCTIVE = new Set(['submit', 'send', 'pay', 'delete'])

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
  if (act.target?.mark !== undefined) {
    const res = resolveMark(act.target.mark, currentMarks, liveCandidates())
    if (res.status === 'lost' || !res.nodeId) {
      // Never a blind click. Ask instead (§12 risk table).
      return confirmToast('That control is no longer on the page. Continue?', runId, index)
    }
    el = byHandle(res.nodeId)
    if (!el) return confirmToast('That control could not be found. Continue?', runId, index)
  } else if (act.target?.selector) {
    el = document.querySelector<HTMLElement>(act.target.selector)
  }

  const verb = (el?.tagName.toLowerCase() === 'button' ? el.textContent?.trim() ?? '' : '') + ' ' + accessibleName(el ?? document.body)

  // Destructive verbs require an explicit human click. Always. (§4)
  if (DESTRUCTIVE.has(act.action) || /\b(submit|send|pay|delete|confirm order|place order)\b/i.test(verb)) {
    return confirmToast(`About to ${act.action || verb.slice(0, 30)} — confirm?`, runId, index)
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
      const value = act.value ?? ''
      if (isSensitiveTarget(el)) {
        return confirmToast('That field holds something sensitive. Fill it in yourself?', runId, index)
      }
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
      // Cross-origin frames that refused injection are fully sensitive (§5).
      let crossOriginSuspect = false
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        try {
          // Reading contentDocument from another origin throws. If it does,
          // our script is not running in that frame → treat it as sensitive.
          void f.contentDocument
        } catch {
          crossOriginSuspect = true
          void chrome.runtime.sendMessage({ kind: 'frame:crossorigin', frameId: f.src })
        }
      }

      const { state, detections } = buildSnapshot(msg.runId, 'pending')
      const marks = currentMarks
      showOverlay(marks)

      await chrome.runtime.sendMessage({
        kind: 'snapshot:ready',
        runId: msg.runId,
        screenState: state,
        rawDetections: detections,
        crossOriginSuspect,
      })
      return { ok: true, detections: detections.length, marks: marks.length }
    }
    case 'content:execute':
      return executeAction(msg.runId, 0, msg.action as PlanAction)
    case 'content:confirm':
      return { ok: true, confirmed: true }
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
