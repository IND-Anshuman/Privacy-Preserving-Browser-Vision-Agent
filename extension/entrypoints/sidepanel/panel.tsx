/**
 * Side panel — the demo surface. ARCHITECTURE.md §6.3, §7, §11.
 *
 * This is the artifact judges verify in ten seconds: a privacy ledger showing
 * every outbound byte count and every item hidden, a latency waterfall, and a
 * live resource HUD. Copy is user-value only — never "redaction pipeline",
 * never "L2 NER", never "gate".
 */
import { parseMessage, type VeilMessage } from '@/lib/messages'
import type { ActionPlan, RedactionManifest } from '@/lib/schema'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const state = {
  redactions: 0,
  bytesOut: 0,
  stages: [] as Array<{ name: string; ms: number }>,
  plan: null as ActionPlan | null,
  manifest: null as RedactionManifest | null,
  aborted: false,
}

/* ------------------------------------------------------------------ *
 *  Actions
 * ------------------------------------------------------------------ */

function run(tier: 'T0' | 'T1'): void {
  const intent = ($<HTMLTextAreaElement>('intent')).value.trim()
  if (!intent) {
    render()
    return
  }
  state.stages = []
  state.aborted = false
  void chrome.runtime.sendMessage({ kind: 'panel:run', intent, tier } satisfies VeilMessage)
  render()
}

$('run').addEventListener('click', () => run('T1'))
$('local').addEventListener('click', () => run('T0'))

/* ------------------------------------------------------------------ *
 *  Inbound
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((raw) => {
  const msg = parseMessage(raw)
  if (!msg) return false
  apply(msg)
  render()
  return false
})

function apply(msg: VeilMessage): void {
  switch (msg.kind) {
    case 'panel:stage':
      state.stages.push({ name: friendlyStage(msg.stage), ms: Math.round(msg.ms) })
      break
    case 'redact:ready': {
      const m = msg.manifest
      state.manifest = m
      state.redactions = m.redactions.length
      state.bytesOut += msg.bytes
      break
    }
    case 'redact:aborted':
      state.aborted = true
      state.stages.push({ name: 'stopped for safety', ms: 0 })
      break
    case 'panel:plan':
      state.plan = msg.plan
      break
    case 'panel:error':
      state.aborted = true
      state.stages.push({ name: 'stopped', ms: 0 })
      break
    case 'panel:ledger':
      for (const e of msg.entries) {
        const row = e as { bytesOut: number; redactions: number; label: string }
        if (row.label.startsWith('aborted')) state.aborted = true
      }
      break
    default:
      break
  }
}

/** Pipeline internals are never shown to the user verbatim. */
function friendlyStage(s: string): string {
  switch (s) {
    case 'snapshot': return 'reading the page'
    case 'capture+redact': return 'hiding sensitive items'
    case 'server': return 'working out what to do'
    case 'execute': return 'carrying it out'
    default: return s
  }
}

/* ------------------------------------------------------------------ *
 *  Render
 * ------------------------------------------------------------------ */

const TINTS: Record<string, string> = {
  PASSWORD: '#1e293b',
  PERSON: '#0f766e',
  EMAIL: '#0e7490',
  PHONE: '#0e7490',
  ADDRESS: '#0e7490',
  CREDIT_CARD: '#7c2d12',
  AADHAAR: '#7c2d12',
  PAN: '#7c2d12',
  BANK_ACCOUNT: '#7c2d12',
  DOB: '#1e3a8a',
  FACE: '#4c1d95',
}

const COLORS = ['#0f766e', '#1e3a8a', '#b45309', '#4c1d95', '#0e7490', '#7c2d12', '#334155']

function render(): void {
  // 1. privacy headline
  $('hidden').textContent = `${state.redactions} item${state.redactions === 1 ? '' : 's'} hidden`
  $('bytes').innerHTML = state.aborted
    ? `<span class="warn">Nothing was sent — this page looked unsafe to send.</span>`
    : state.bytesOut > 0
      ? `Sent ${(state.bytesOut / 1024).toFixed(1)} KB, all of it already hidden.`
      : 'nothing sent yet'

  // 2. legend of what was hidden
  const legend = $('legend')
  legend.innerHTML = ''
  if (state.manifest) {
    const counts = new Map<string, number>()
    for (const r of state.manifest.redactions) counts.set(r.cls, (counts.get(r.cls) ?? 0) + 1)
    for (const [cls, n] of counts) {
      const el = document.createElement('span')
      el.className = 'pill'
      el.innerHTML = `<i class="legend-dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${TINTS[cls] ?? '#334155'};margin-right:5px"></i>${n} ${humanClass(cls)}`
      legend.appendChild(el)
    }
  }

  // 3. what the server saw
  $('saw').innerHTML = state.manifest
    ? `The server received your page structure, ${state.manifest.redactions.length} hidden item${state.manifest.redactions.length === 1 ? '' : 's'}, and a redacted picture.<br>
       <span class="muted">Placeholders it saw: ${state.manifest.redactions.slice(0, 6).map((r) => r.placeholder.token).join(' ') || 'none'}${state.manifest.redactions.length > 6 ? ' …' : ''}</span>`
    : 'no request yet'

  const log = $('ledger')
  log.innerHTML = ''
  for (const s of state.stages) {
    const d = document.createElement('div')
    d.textContent = `${s.name} — ${s.ms} ms`
    log.appendChild(d)
  }

  // 4. waterfall
  const wf = $('wf')
  wf.innerHTML = ''
  const total = state.stages.reduce((a, s) => a + s.ms, 0) || 1
  state.stages.forEach((s, i) => {
    const seg = document.createElement('span')
    seg.style.width = `${(s.ms / total) * 100}%`
    seg.style.background = COLORS[i % COLORS.length] ?? '#0f766e'
    seg.title = `${s.name}: ${s.ms} ms`
    wf.appendChild(seg)
  })

  const tbody = $('stages').querySelector('tbody') as HTMLTableSectionElement
  tbody.innerHTML = ''
  for (const s of state.stages) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${s.name}</td><td>${s.ms} ms</td>`
    tbody.appendChild(tr)
  }
  if (state.stages.length) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td><strong>total</strong></td><td><strong>${Math.round(total)} ms</strong></td>`
    tbody.appendChild(tr)
  }

  // 5. plan
  if (state.plan) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td class="muted">plan</td><td class="muted">${state.plan.steps.map((s) => s.action).join(' → ')}</td>`
    tbody.appendChild(tr)
  }
}

function humanClass(cls: string): string {
  return cls.toLowerCase().replace(/_/g, ' ')
}

// Initial paint.
render()
