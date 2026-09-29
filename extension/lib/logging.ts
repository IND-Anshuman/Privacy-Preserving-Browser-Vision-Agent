/**
 * A log that survives the thing it is logging about.
 *
 * WHY THIS EXISTS
 * ---------------
 * The report was "the debug console is empty even when I ask a question", and
 * that was TRUE: 282 of this project's console.* calls are in bench scripts,
 * and the runtime files logged essentially nothing. Adding console.log alone
 * would not have fixed it, because the most common failure in this extension
 * is the MV3 service worker being TERMINATED MID-RUN — which destroys the
 * console buffer along with the run state. A log that dies with the process
 * cannot report the process dying.
 *
 * So the log is a bounded ring buffer, persisted to chrome.storage.session,
 * and rendered in the panel. That survives a worker restart, which a
 * console.log never can.
 *
 * THE HARD CONSTRAINT
 * -------------------
 * A log is a place secrets go to leak. This project has a key in .env and a
 * bearer token in an Authorization header, and either would end up in a
 * console line the moment someone logged a request. So every entry is
 * scrubbed ON THE WAY IN, not on the way out: an entry that is never
 * written cannot be leaked by a later bug in the reader.
 */

/** Which part of the extension a line came from. */
export type LogChannel = 'sw' | 'content' | 'offscreen' | 'panel'
export type LogLevel = 'info' | 'warn' | 'error'

export const LOG_CHANNELS: readonly LogChannel[] = ['sw', 'content', 'offscreen', 'panel']

export interface LogEntry {
  t: number
  channel: LogChannel
  level: LogLevel
  text: string
}

/**
 * Bounded so a runaway loop cannot fill storage. 200 lines is roughly one
 * full run's worth of stage transitions on a busy page.
 */
export const RING_BUFFER_MAX = 200

/**
 * Values that must never be written to a log, however they are phrased.
 *
 * These are matched on the VALUE, not the key, so `key=...`, `: ...`,
 * `Bearer ...` and a bare token are all caught. The order matters: the bearer
 * pattern runs first because it would otherwise leave the prefix behind.
 */
const SCRUBBERS: readonly RegExp[] = [
  // sk-... / hf_... / ghp_... style API keys, with or without a prefix.
  /\b(?:sk|pk|rk|hf|ghp|glpat|xoxb|api)[-_][A-Za-z0-9_-]{12,}\b/g,
  // A JWT. Three base64url segments is distinctive enough and specific enough.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  // key: value for anything that names a secret.
  /\b(api[_-]?key|apikey|secret|password|passwd|token|authorization|bearer)\b(\s*[:=]\s*)("?)([^\s",}]+)\3/gi,
]

/** Long opaque runs of base64-ish characters — a raw token with no label. */
const BARE_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g

/**
 * Remove anything that looks like a credential.
 *
 * Exported because it must be testable on its own: a scrubber that is only
 * ever exercised through the log is a scrubber nobody checks.
 */
export function scrub(text: string): string {
  let out = text
  for (const re of SCRUBBERS) out = out.replace(re, (_m, sep?: string, _q?: string, val?: string) =>
    // key=value -> key=[redacted]; a matched bearer/prefix form -> [redacted].
    sep ? `${sep === ':' || sep === '=' ? sep : sep}[redacted]` : '[redacted]',
  )
  // A frame_hash, a data: URL tail, or a model blob can be a long base64 run
  // with no key at all. It is not a credential, but it IS page content, and
  // page content must not sit in a log either.
  out = out.replace(BARE_TOKEN, (m) => (m.length > 64 ? `[redacted:${m.length} chars]` : '[redacted]'))
  return out
}

/** Keep one line per entry, and keep lines from becoming megabyte records. */
function clamp(text: string, max = 500): string {
  const oneLine = text.replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

export class LogRing {
  private entries: LogEntry[] = []

  push(channel: LogChannel, text: string, level: LogLevel = 'info'): LogEntry {
    const entry: LogEntry = { t: Date.now(), channel, level, text: clamp(scrub(text)) }
    this.entries.push(entry)
    // Drop the OLDEST. A ring that grows without bound is a memory leak in a
    // service worker that gets restarted constantly anyway.
    if (this.entries.length > RING_BUFFER_MAX) this.entries.splice(0, this.entries.length - RING_BUFFER_MAX)
    return entry
  }

  all(): LogEntry[] {
    return this.entries.slice()
  }

  /** For the panel. Scrubs again, because a value scrubbed on the way in can
   *  still be assembled from several innocuous-looking entries. */
  allForDisplay(): LogEntry[] {
    return this.entries.map((e) => ({ ...e, text: scrub(e.text) }))
  }

  clear(): void {
    this.entries = []
  }

  /** Plain text, for the copy-to-clipboard path in the panel. */
  toText(): string {
    return this.allForDisplay()
      .map((e) => {
        const at = new Date(e.t).toISOString().slice(11, 23)
        return `${at} ${e.channel.padEnd(8)} ${e.level.padEnd(5)} ${e.text}`
      })
      .join('\n')
  }
}

/**
 * The one logger every runtime file uses.
 *
 * Writes to the console AND the ring. The console copy is for a developer
 * with devtools open; the ring copy is for the user whose worker died.
 */
export function createLogger(ring: LogRing) {
  return function log(channel: LogChannel, text: string, level: LogLevel = 'info'): void {
    const entry = ring.push(channel, text, level)
    const line = `[veil:${channel}] ${entry.text}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
}

/**
 * Storage key, and why session rather than local.
 *
 * `chrome.storage.session` lives in memory for the browser session and is
 * readable by the service worker AND the side panel, which is exactly the
 * sharing we need. It is not written to disk, so a log cannot outlive the
 * browser session and cannot be read by another profile.
 */
export const LOG_STORAGE_KEY = 'veilLog'

export async function persistRing(ring: LogRing): Promise<void> {
  try {
    await chrome.storage.session.set({ [LOG_STORAGE_KEY]: ring.all() })
  } catch {
    // storage.session is unavailable in some Firefox builds. Losing the log is
    // acceptable; failing the run over it is not.
  }
}

export async function restoreRing(ring: LogRing): Promise<void> {
  try {
    const got = await chrome.storage.session.get(LOG_STORAGE_KEY)
    const stored = got[LOG_STORAGE_KEY]
    if (Array.isArray(stored)) {
      for (const e of stored) {
        if (e && typeof e.text === 'string') ring.push(e.channel, e.text, e.level)
      }
    }
  } catch {
    /* nothing to restore */
  }
}
