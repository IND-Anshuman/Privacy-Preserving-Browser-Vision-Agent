/**
 * Frame routing — audit finding 0.2.
 *
 * `allFrames: true` is required for PERCEPTION: every frame must report its own
 * DOM or the redaction cascade cannot see inside an iframe, and its content
 * ships in the clear. That registration is not negotiable.
 *
 * But it also meant `content:execute` was a broadcast. Each frame resolved the
 * mark against its own document, so one planned click fired in the top frame
 * AND in every same-origin iframe that contained a matching element. Three
 * "Submit" buttons on three documents, one instruction.
 *
 * So the two directions get opposite rules, and that asymmetry is the whole
 * point of this module:
 *
 *   - `report`  — always true. Perception fans out.
 *   - `execute` — true only in the one frame the plan named.
 *
 * The asymmetry fails SAFE: a frame that is not the target does nothing at all,
 * rather than doing something plausible in the wrong document.
 */

export interface FrameRouting {
  /** Chrome's frame id. 0 is the top-level document. */
  frameId: number
  isTop: boolean
}

export interface FrameDecision {
  /** Should this frame perform the action? */
  execute: boolean
  /** Should this frame report its snapshot to the service worker? */
  report: boolean
  /** Human-readable justification, surfaced when a step fails. */
  reason: string
}

/**
 * Decide what this frame does with a message aimed at `target`.
 *
 * `target` is null when the message carries no frame information at all. That
 * case deliberately does NOT execute: an unscoped action is exactly the
 * fan-out bug, so the absence of scope is treated as "no frame claimed it"
 * rather than "every frame claimed it".
 */
export function frameDecision(self: FrameRouting, target: FrameRouting | null): FrameDecision {
  // Perception is never scoped.
  if (!target) {
    return {
      execute: false,
      report: true,
      reason: 'no frame information on this message, so it does not execute',
    }
  }
  if (target.frameId === self.frameId) {
    return {
      execute: true,
      report: true,
      reason: self.isTop ? 'top frame' : `frame ${self.frameId}`,
    }
  }
  return {
    execute: false,
    report: true,
    reason: `frame ${self.frameId} is not the target frame (${target.frameId})`,
  }
}
