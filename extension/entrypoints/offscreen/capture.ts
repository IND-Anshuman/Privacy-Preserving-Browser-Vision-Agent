/**
 * Capture ladder — ARCHITECTURE.md §2.
 *
 *   1. chrome.tabCapture MediaStream   (default; live; zero per-frame API cost)
 *   2. chrome.tabs.captureVisibleTab  (fallback; HARD-throttled to 2 calls/sec)
 *   3. Region Capture crop             (compositor-level crop of 1 or 2)
 *
 * Every function that touches a browser API that cannot be driven from a test
 * is behind a narrow interface, so the ladder's decision logic is testable and
 * the untestable parts are obvious to a human reviewer. Those are marked
 * `MANUAL VERIFY` and listed in the README's manual-checklist.
 */
import type { Box } from '@/lib/schema'

/* ------------------------------------------------------------------ *
 *  Capability detection
 * ------------------------------------------------------------------ */

export interface CaptureCaps {
  tabCapture: boolean
  captureVisibleTab: boolean
  regionCapture: boolean
  offscreen: boolean
  webgpu: boolean
  computePressure: boolean
  promptApi: boolean
  /** Why a capability is missing — surfaced in the HUD, never guessed at. */
  notes: string[]
}

export async function detectCaptureCaps(): Promise<CaptureCaps> {
  const notes: string[] = []

  const tabCapture = typeof chrome !== 'undefined' && typeof chrome.tabCapture?.getMediaStreamId === 'function'
  if (!tabCapture) notes.push('chrome.tabCapture unavailable (absent on Firefox) — using captureVisibleTab')

  const captureVisibleTab =
    typeof chrome !== 'undefined' && typeof chrome.tabs?.captureVisibleTab === 'function'
  if (!captureVisibleTab) notes.push('chrome.tabs.captureVisibleTab unavailable')

  const offscreen = typeof chrome !== 'undefined' && typeof chrome.offscreen?.createDocument === 'function'
  if (!offscreen) notes.push('chrome.offscreen unavailable — GPU compositing degraded to 2D canvas')

  // Region Capture: CropTarget exists but track.cropTo() is the real gate,
  // and Firefox has neither. Feature-detect, never assume. [§2 mode 3]
  const regionCapture =
    typeof (globalThis as { CropTarget?: unknown }).CropTarget !== 'undefined' &&
    typeof (MediaStreamTrack.prototype as { cropTo?: unknown }).cropTo === 'function'
  if (!regionCapture) notes.push('Region Capture unavailable — capturing the full viewport')

  const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  if (!webgpu) notes.push('WebGPU unavailable — using the WASM path')

  const computePressure = typeof (globalThis as { PressureObserver?: unknown }).PressureObserver === 'function'
  if (!computePressure) notes.push('Compute Pressure API unavailable — cascade runs at full strength')

  const promptApi = typeof (globalThis as { LanguageModel?: unknown }).LanguageModel === 'object'
  if (!promptApi) notes.push('Chrome Prompt API unavailable — tier-0 falls back to the local SmolVLM')

  return { tabCapture, captureVisibleTab, regionCapture, offscreen, webgpu, computePressure, promptApi, notes }
}

/* ------------------------------------------------------------------ *
 *  Throttle: captureVisibleTab is hard-capped at 2 calls/sec by Chrome.
 *  We poll at 1.5 Hz and only when the frame-diff gate says something
 *  changed. Getting this wrong is a silent 403/throttle storm.
 * ------------------------------------------------------------------ */

export const MAX_CAPTURE_CALLS_PER_SECOND = 2
export const SNAPSHOT_POLL_HZ = 1.5

export class CaptureThrottle {
  private last = 0
  private readonly minIntervalMs: number

  constructor(hz: number = SNAPSHOT_POLL_HZ) {
    this.minIntervalMs = 1000 / Math.min(hz, MAX_CAPTURE_CALLS_PER_SECOND)
  }

  /** True if a capture is allowed now; records the call when it is. */
  tryAcquire(nowMs: number = performance.now()): boolean {
    if (nowMs - this.last < this.minIntervalMs) return false
    this.last = nowMs
    return true
  }

  /** ms until the next call is permitted. */
  waitMs(nowMs: number = performance.now()): number {
    return Math.max(0, this.minIntervalMs - (nowMs - this.last))
  }
}

/* ------------------------------------------------------------------ *
 *  Mode selection — pure, so it is unit-testable
 * ------------------------------------------------------------------ */

export type CaptureMode = 'stream' | 'snapshot' | 'pixel-only'

export interface ModeDecision {
  mode: CaptureMode
  reason: string
  /** Region Capture crop target rect, when we can use one. */
  crop?: Box
}

/**
 * Decide which rung of the ladder to use. `preferRegion` is true when the
 * content script handed us a main-content rect to crop to.
 */
export function chooseMode(
  caps: CaptureCaps,
  opts: { wantLive: boolean; preferRegion: boolean; hasBoxes: boolean },
): ModeDecision {
  if (caps.tabCapture && opts.wantLive) {
    const d: ModeDecision = { mode: 'stream', reason: 'tabCapture MediaStream (live)' }
    // Region Capture is a modifier on top of either rung, not a rung itself:
    // it crops the track at the compositor, so it only matters once we have one.
    if (opts.preferRegion && caps.regionCapture) d.crop = { x: 0, y: 0, w: 0, h: 0 }
    return d
  }
  if (caps.captureVisibleTab) {
    // Chrome hard-throttles this to 2 calls/sec, so we poll at 1.5Hz and only
    // when the frame-diff gate says the page changed.
    return {
      mode: 'snapshot',
      reason: `captureVisibleTab (throttled to ${SNAPSHOT_POLL_HZ}Hz behind the frame-diff gate)`,
    }
  }
  if (opts.hasBoxes) {
    // We can still detect PII from the DOM channel alone. Degraded, still
    // private — this is the documented pixel-only tier.
    return { mode: 'pixel-only', reason: 'no capture API — DOM channel only, no frame sent' }
  }
  return { mode: 'pixel-only', reason: 'no usable capture API' }
}

/* ------------------------------------------------------------------ *
 *  Actual capture. MANUAL VERIFY: these touch permission-gated APIs that no
 *  automated test can exercise. Each is isolated here on purpose.
 * ------------------------------------------------------------------ */

export interface Capturer {
  mode: CaptureMode
  /** Acquire a frame as a drawable source for an OffscreenCanvas. */
  grab(): Promise<ImageBitmap | VideoFrame | null>
  /** Stop any held resources. */
  release(): void
  /** Region Capture crop, if the ladder chose one. */
  cropToContentArea(rect: Box): Promise<boolean>
}

const CANVAS_W = 1280 // §4: cap the long edge, DPR-clamped

/**
 * Rung 1: tabCapture MediaStream. VideoFrames transfer by reference through
 * structured clone, so there is no per-frame pixel copy. MANUAL VERIFY.
 */
class StreamCapturer implements Capturer {
  mode: CaptureMode = 'stream'
  private video: HTMLVideoElement
  private stream: MediaStream | null = null
  private audioCtx: AudioContext | null = null
  private raf = 0
  private pending: { frame: VideoFrame; at: number } | null = null

  constructor(private tabId: number) {
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
  }

  async start(): Promise<boolean> {
    // getMediaStreamId is callback-style and returns void; it must be promisified
    // by hand. Note it can only be called from a context that will go on to
    // call getUserMedia, and the streamId expires in a few seconds if unused.
    const streamId = await new Promise<string>((resolve, reject) => {
      try {
        chrome.tabCapture.getMediaStreamId({ targetTabId: this.tabId }, (id: string) => {
          if (id) resolve(id)
          else reject(new Error('empty streamId'))
        })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    if (!streamId) return false
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as unknown as MediaTrackConstraints,
      audio: false,
    })
    this.video.srcObject = this.stream
    await this.video.play()

    // Once you hold the stream, tab audio stops reaching the speaker. Re-route
    // it through an AudioContext so the user still hears the tab. [§2 note 1]
    try {
      const withAudio = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as unknown as MediaTrackConstraints,
      })
      this.audioCtx = new AudioContext()
      const src = this.audioCtx.createMediaStreamSource(withAudio)
      this.audioCtx.createMediaStreamDestination().stream.getAudioTracks().forEach((t) => t.stop())
      src.connect(this.audioCtx.destination)
    } catch {
      // No tab audio available on this platform. Not fatal: the user simply
      // hears the tab directly, and we do not fail the capture over it.
    }

    // VideoFrame is constructible in a window context but the DOM lib types
    // it as an interface only, so the constructor is reached through a typed
    // alias rather than an `any` cast.
    const FrameCtor = VideoFrame as unknown as {
      new (source: CanvasImageSource, init?: { timestamp?: number }): VideoFrame
    }
    const pump = () => {
      if (!this.video.videoWidth) {
        this.raf = requestAnimationFrame(pump)
        return
      }
      try {
        const frame = new FrameCtor(this.video, { timestamp: performance.now() * 1000 })
        const prev = this.pending
        this.pending = { frame, at: performance.now() }
        // The previous frame is closed here: holding VideoFrames open leaks
        // GPU memory and eventually kills the tab.
        prev?.frame.close()
      } catch {
        // Frame construction can fail transiently while the track is starting.
      }
      this.raf = requestAnimationFrame(pump)
    }
    pump()
    return true
  }

  async grab(): Promise<VideoFrame | null> {
    return this.pending?.frame ?? null
  }

  /** Peek without consuming — used by the frame-diff gate each tick. */
  peek(): { frame: VideoFrame; at: number } | null {
    return this.pending
  }

  async cropToContentArea(rect: Box): Promise<boolean> {
    // Region Capture: the crop follows the element as it moves. MANUAL VERIFY.
    if (!this.stream) return false
    const track = this.stream.getVideoTracks()[0] as MediaStreamTrack & { cropTo?: (t: unknown) => Promise<void> }
    if (typeof track.cropTo !== 'function') return false
    const CropTargetCtor = (globalThis as { CropTarget?: { fromElement(el: Element): Promise<unknown> } }).CropTarget
    if (!CropTargetCtor) return false
    const el = document.querySelector('main, #content, body')
    if (!el) return false
    try {
      const target = await CropTargetCtor.fromElement(el)
      await track.cropTo(target)
      return true
    } catch {
      return false
    }
  }

  release(): void {
    cancelAnimationFrame(this.raf)
    this.pending?.frame.close()
    this.pending = null
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.audioCtx?.close()
    this.stream = null
  }
}

/** Rung 2: captureVisibleTab. Throttle-enforced by the caller. MANUAL VERIFY. */
class SnapshotCapturer implements Capturer {
  mode: CaptureMode = 'snapshot'
  private lastDataUrl: string | null = null
  constructor(private throttle: CaptureThrottle) {}

  async grab(): Promise<ImageBitmap | null> {
    if (!this.throttle.tryAcquire()) return null
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' })
    this.lastDataUrl = dataUrl
    const blob = await (await fetch(dataUrl)).blob()
    return createImageBitmap(blob)
  }

  cropToContentArea(): Promise<boolean> {
    // captureVisibleTab cannot be cropped at the compositor; we crop the
    // bitmap in the compositor pass instead. Return false so the caller does
    // not assume a compositor-level crop happened.
    return Promise.resolve(false)
  }

  release(): void {
    this.lastDataUrl = null
  }
}

/** Rung 3-degraded: no capture at all. Pixel-only tier. */
class NullCapturer implements Capturer {
  mode: CaptureMode = 'pixel-only'
  grab(): Promise<null> {
    return Promise.resolve(null)
  }
  release(): void {}
  cropToContentArea(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

export async function createCapturer(
  caps: CaptureCaps,
  tabId: number,
  decision: ModeDecision,
): Promise<Capturer> {
  if (decision.mode === 'stream' && caps.tabCapture) {
    const c = new StreamCapturer(tabId)
    const ok = await c.start().catch(() => false)
    if (ok) return c
  }
  if (caps.captureVisibleTab) return new SnapshotCapturer(new CaptureThrottle())
  return new NullCapturer()
}

export function capToWidth(w: number, h: number, maxEdge = CANVAS_W): { w: number; h: number; scale: number } {
  const long = Math.max(w, h)
  if (long <= maxEdge) return { w, h, scale: 1 }
  const scale = maxEdge / long
  return { w: Math.round(w * scale), h: Math.round(h * scale), scale }
}
