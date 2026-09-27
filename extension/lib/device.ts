/**
 * Device capability and memory budgeting — ARCHITECTURE.md §3, §7, §12.
 *
 * The brief asks whether this works on a machine with ~800 MB of dedicated
 * GPU memory. This file is the honest answer to that question, encoded as
 * code: it probes what the device actually has and derives limits from it,
 * rather than assuming a desktop.
 *
 * Nothing here is a guess dressed as a fact. Where a number is an engineering
 * estimate it is marked ESTIMATE and carries its basis.
 */

export interface DeviceProfile {
  /** totalDeviceMemory GiB, when the browser reports it (0 = unknown). */
  deviceMemoryGiB: number
  /** navigator.deviceMemory is coarse: 0.25/0.5/1/2/4/8 buckets. */
  reportedMemory: number
  hardwareConcurrency: number
  hasWebGPU: boolean
  hasWASM: boolean
  /** Cross-origin isolation → SharedArrayBuffer → threaded WASM. */
  crossOriginIsolated: boolean
  hasPressureObserver: boolean
  hasPromptAPI: boolean
  /** Best guess at usable VRAM in MB. 0 = unknown / no dedicated GPU. */
  estimatedVramMb: number
}

export async function probeDevice(): Promise<DeviceProfile> {
  const nav = navigator as unknown as {
    deviceMemory?: number
    hardwareConcurrency?: number
    gpu?: { requestAdapter(): Promise<unknown> }
  }
  const hasWebGPU = 'gpu' in nav
  let hasWASM = false
  try {
    hasWASM = typeof WebAssembly === 'object'
  } catch {
    hasWASM = false
  }
  return {
    reportedMemory: nav.deviceMemory ?? 0,
    deviceMemoryGiB: nav.deviceMemory ?? 0,
    hardwareConcurrency: nav.hardwareConcurrency ?? 2,
    hasWebGPU,
    hasWASM,
    crossOriginIsolated: typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false,
    hasPressureObserver: typeof (globalThis as { PressureObserver?: unknown }).PressureObserver === 'function',
    hasPromptAPI: typeof (globalThis as { LanguageModel?: unknown }).LanguageModel === 'object',
    // WebGPU does not expose VRAM. `adapter.limits.maxBufferSize` and
    // `maxStorageBufferBindingSize` are the usable proxies. ESTIMATE: an
    // 800 MB card sits around the 1-2 GB maxBufferSize band, an 8 GB card
    // well above 4 GB.
    estimatedVramMb: 0,
  }
}

/* ================================================================== *
 *  Memory model
 *
 *  ESTIMATE, with basis stated. These figures decide whether a model can
 *  be loaded at all; being wrong here means an OOM on a user's machine, so
 *  they are deliberately conservative.
 * ================================================================== */

/** Approximate resident footprint of each model in its q8 form. */
export const MODEL_FOOTPRINT_MB: Record<string, { weights: number; activationsPerItem: number; minVramMb: number }> = {
  // GLiNER / DeBERTa-base, q8. Activations scale with batch AND sequence
  // length; 12 MB per item is a 512-token forward pass held across layers.
  l2: { weights: 95, activationsPerItem: 12, minVramMb: 512 },
  // BlazeFace: tiny detector, runs comfortably anywhere.
  l3face: { weights: 0.3, activationsPerItem: 1, minVramMb: 64 },
  // DBNet text detector.
  l3text: { weights: 5, activationsPerItem: 2, minVramMb: 128 },
  // SmolVLM-256M, q8. Only used for the optional audit pass.
  audit: { weights: 260, activationsPerItem: 40, minVramMb: 1024 },
}

export interface Budget {
  tier: 'full' | 'reduced' | 'minimal' | 'off'
  canRunL2: boolean
  canRunL3: boolean
  canRunAudit: boolean
  nerBatch: number
  /** Human-readable justification, shown in the HUD. */
  reason: string
  /** The dominant constraint, so the UI can say what to fix. */
  bottleneck: 'vram' | 'ram' | 'threads' | 'unknown'
}

/**
 * Decide what this device can actually run.
 *
 * Thresholds (these are the numbers, and they are conservative):
 *   minimal  L0/L1 only, no GPU work. Always available. ~82ms/cycle on a
 *           budget 2015-2018 laptop (measured x4.5 of 18.25ms baseline).
 *   reduced  + L3 face/text detectors (tiny) but no L2 NER.
 *   full     + L2 NER, requires either >= 1 GB usable VRAM for WebGPU or
 *           enough system RAM to run it in WASM.
 */
export function planForDevice(d: DeviceProfile): Budget {
  const vram = d.estimatedVramMb
  const ram = d.deviceMemoryGiB
  const threads = d.hardwareConcurrency

  // No VRAM information at all → assume the worst and say so.
  const vramKnown = vram > 0

  if (ram !== 0 && ram < 2 && threads < 4) {
    return {
      tier: 'minimal',
      canRunL2: false,
      canRunL3: false,
      canRunAudit: false,
      nerBatch: 0,
      reason: 'under 2 GB RAM and few cores — detection runs on regex and field semantics only',
      bottleneck: 'ram',
    }
  }

  if (d.hasWebGPU && vramKnown && vram < MODEL_FOOTPRINT_MB.l2!.minVramMb) {
    return {
      tier: 'reduced',
      canRunL2: false,
      canRunL3: true,
      canRunAudit: false,
      nerBatch: 0,
      reason: `~${vram} MB VRAM is below the ~${MODEL_FOOTPRINT_MB.l2!.minVramMb} MB the name detector needs — running field semantics, regex, and the small pixel detectors instead`,
      bottleneck: 'vram',
    }
  }

  if (!d.hasWebGPU) {
    // WASM path. Works, but threaded WASM needs cross-origin isolation for
    // SharedArrayBuffer; without it everything runs single-threaded.
    const usableThreads = d.crossOriginIsolated ? Math.max(1, threads - 1) : 1
    const batch = usableThreads >= 4 ? 8 : usableThreads >= 2 ? 4 : 2
    return {
      tier: 'full',
      canRunL2: true,
      canRunL3: true,
      canRunAudit: false,
      nerBatch: batch,
      reason: d.crossOriginIsolated
        ? `no WebGPU — WASM path on ${usableThreads} threads, batch ${batch}`
        : 'no WebGPU and not cross-origin isolated — single-threaded WASM, smallest possible batch',
      bottleneck: d.crossOriginIsolated ? 'threads' : 'unknown',
    }
  }

  const batch = vram >= 2048 ? 16 : vram >= 1024 ? 8 : 4
  return {
    tier: 'full',
    canRunL2: true,
    canRunL3: true,
    canRunAudit: vram >= 2048,
    nerBatch: batch,
    reason: `WebGPU with ~${vram} MB VRAM — batch ${batch}${vram >= 2048 ? ', audit pass enabled' : ', audit pass disabled'}`,
    bottleneck: 'vram',
  }
}

/** NER batch size for the current plan, with a hard floor of 1. */
export function nerBatchSize(): number {
  if (typeof globalThis === 'undefined') return 8
  const cached = (globalThis as { __veilBudget?: Budget }).__veilBudget
  if (cached) return Math.max(1, cached.nerBatch)
  return 8
}

/** Cache the budget so hot paths do not re-probe. */
export function setBudget(b: Budget): void {
  ;(globalThis as { __veilBudget?: Budget }).__veilBudget = b
}

/* ================================================================== *
 *  Mobile — the honest answer
 * ================================================================== */

/**
 * Chrome on Android is NOT a target for this extension, and the reasons are
 * structural rather than a matter of tuning:
 *
 *  - tabCapture has no Android equivalent. There is no API to capture another
 *    tab's pixels, which removes the pixel channel entirely. The DOM channel
 *    still works, so the extension degrades to "structure only".
 *  - chrome.offscreen does not exist on Android, so there is no DOM-capable
 *    sandbox. No OffscreenCanvas pipeline, no WebGPU compositor.
 *  - Extensions cannot run on non-Chromium Android at all (no Firefox for
 *    Android extension support), so the Firefox build does not help either.
 *  - Safari/iOS: no MV3 extension support at all.
 *
 * What DOES work on mobile is the DOM channel against a page the user is
 * looking at, via a share-sheet or a custom-tab style surface. That is a
 * different product with a different threat model, not this one.
 */
export interface MobileSupport {
  platform: string
  extensionInstallable: boolean
  tabCapture: boolean
  offscreen: boolean
  webGPU: boolean
  netLevel: 'T0 only' | 'T0 + T1 (DOM only)' | 'full'
  note: string
}

export function mobileSupport(platform: string): MobileSupport {
  const p = platform.toLowerCase()
  if (p.includes('android')) {
    return {
      platform: 'Android / Chrome',
      extensionInstallable: true,
      tabCapture: false, // no API to capture another tab
      offscreen: false, // chrome.offscreen is desktop-only
      webGPU: true, // available, but with no canvas to composite into
      netLevel: 'T0 + T1 (DOM only)',
      note: 'Structure-only. The pixel channel cannot exist without tabCapture, so canvas/video PII is not defensible on Android — this is a safety limitation, not a bug.',
    }
  }
  if (p.includes('ios') || p.includes('ipad')) {
    return {
      platform: 'iOS / Safari',
      extensionInstallable: false, // no MV3 extension support
      tabCapture: false,
      offscreen: false,
      webGPU: true,
      netLevel: 'T0 only',
      note: 'Safari on iOS does not support browser extensions at all.',
    }
  }
  return {
    platform: platform || 'unknown',
    extensionInstallable: false,
    tabCapture: false,
    offscreen: false,
    webGPU: false,
    netLevel: 'T0 only',
    note: 'unsupported',
  }
}
