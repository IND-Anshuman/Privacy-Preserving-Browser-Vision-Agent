/**
 * Why a message did not come back, said in words the user can act on.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `toContent()` catches every `chrome.tabs.sendMessage` rejection and returns
 * `{ blocked: true }`. The EXECUTION path reads that field, so a missing port
 * fails a step immediately. The SNAPSHOT path did not — so a run would report
 * `snapshot 2ms`, return `{ok: true}`, and then wait for a `snapshot:ready`
 * that could never arrive.
 *
 * That is not a cosmetic problem. A 2 ms "snapshot" is the tell: a real DOM
 * walk of a page with fifty elements cannot take 2 ms, and the reason it did
 * is that `sendMessage` rejected in 2 ms because nothing was listening. The
 * failure was already knowable, synchronously, at the moment the run started.
 * Instead the user waited out the watchdog.
 *
 * So the three real causes are separated, because they are three different
 * problems with three different fixes and the user can only act on the one
 * that is actually true.
 */

/** What a blocked send looks like, as `toContent` returns it. */
export function isBlockedResult(res: unknown): boolean {
  return typeof res === 'object' && res !== null && (res as { blocked?: unknown }).blocked === true
}

export type BlockReason = 'chrome' | 'restricted' | 'not-injected' | 'unknown'

/**
 * Pick the most likely cause from the tab URL.
 *
 * The URL is the only evidence available, and it is enough to separate the
 * cases a user can act on from the ones they cannot.
 */
export function classifyBlockedUrl(url: string | undefined): BlockReason {
  if (!url) return 'unknown'
  // The browser's own pages. Extensions cannot be injected here at all — it is
  // a product decision, not a bug, and no reload will change it.
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i.test(url)) return 'chrome'
  // The Chrome Web Store blocks extensions from their own pages.
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) return 'restricted'
  // Anything else that is not http(s) is a page we simply cannot script.
  if (!/^https?:\/\//i.test(url)) return 'restricted'
  // A normal web page with no content script is nearly always this: the
  // extension was installed, reloaded, or updated AFTER the tab was opened, so
  // the content script was never injected into it.
  return 'not-injected'
}

export interface SnapshotFailure {
  reason: BlockReason
  message: string
}

/**
 * The message. Each branch has to give the user a NEXT ACTION, because a
 * diagnosis without an action just moves the problem.
 */
export function describeSnapshotFailure(reason: BlockReason): string {
  switch (reason) {
    case 'chrome':
      return (
        "Veil can't run on a browser page. Chrome does not let extensions read " +
        "chrome:// or the new-tab page — that's a browser rule, not a fault here. " +
        "Open a normal website (or your local test form) and try again."
      )
    case 'restricted':
      return (
        "This page doesn't allow extensions to run. That applies to browser " +
        "settings pages and to some extension galleries, and no reload will " +
        "change it. Open a normal website and try again."
      )
    case 'not-injected':
      return (
        "Veil isn't running on this tab yet. The page was already open when the " +
        "extension was installed, reloaded, or updated, so its content script " +
        "was never added. RELOAD THE PAGE (the refresh button, not the extension's) " +
        "and try again."
      )
    default:
      return (
        "Veil couldn't read this page, so it stopped before sending anything. " +
        "Reload the page and try again; if it keeps happening, check that the " +
        "extension is enabled in chrome://extensions."
      )
  }
}

export function snapshotFailure(url: string | undefined): SnapshotFailure {
  const reason = classifyBlockedUrl(url)
  return { reason, message: describeSnapshotFailure(reason) }
}
