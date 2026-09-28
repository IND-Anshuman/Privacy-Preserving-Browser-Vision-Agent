/**
 * L2 admission policy — MEASURED, and the decision changed when the model did.
 *
 * HISTORY, because getting this wrong is how a privacy tool ends up quietly
 * useless (or quietly over-redacting):
 *
 *  · Revision 1 disabled L2 entirely. The evidence was that
 *    `Xenova/bert-base-NER` returned no entities for an email address. That
 *    was a true observation of a CoNLL-2003 model — whose label space genuinely
 *    has no PII classes — generalised into "no browser-loadable NER has PII".
 *    The generalisation was wrong.
 *  · Revision 2 swapped in `onnx-community/bert-small-pii-detection-ONNX`
 *    (24 PII classes, 27.4 MB q8) and MEASURED it on the corpus. Raw L2:
 *      P=0.119  R=0.569  F1=0.197   — recall excellent, precision not
 *    Tuned per class (bench/tune_pii_thresholds.ts), the fused cascade:
 *      L0+L1 only   P=0.954 R=0.669 F1=0.787
 *      tuned        P=0.720 R=0.798 F1=0.757
 *      delta        F1 -0.030   R +0.129   P -0.234
 *
 * So the honest position is neither "off" nor "on at any price": L2 buys
 * +0.129 recall and PERSON goes 42→53 of 54, at a cost of 0.234 precision
 * overall. Overall F1 is *worse*, so a single global operating point is wrong.
 *
 * The shipping decision is therefore PER CLASS, and it is the one a privacy
 * tool should make: admit an L2 span when it costs precision but buys recall
 * on a class regex structurally cannot reach (PERSON), and reject it where L1
 * is already exact and L2 only adds noise (LOCATION, which alone produced 337
 * false positives).
 *
 * Precision on a redaction layer is not symmetric with recall: a false
 * positive costs a useless black box, a false negative leaks. The thresholds
 * below were chosen by measurement, not by that argument alone — re-run the
 * sweep if the model or the corpus changes.
 */

/** Per-class confidence floor. 1.01 = never admit an L2 span for this class. */
export const L2_TAU: Record<string, number> = {
  // Regex cannot find a name in prose. This is the class L2 exists for, and
  // PERSON recall goes 42/54 -> 53/54 with it enabled.
  PERSON: 0.99,
  // L1 already finds these by exact pattern, and L2 adds duplicates without
  // adding coverage, so the measured gain is zero at a real precision cost.
  EMAIL: 1.01,
  PHONE: 1.01,
  LOCATION: 1.01, // 337 false positives at any threshold
  ORG: 1.01,
  DATE: 1.01,
  PASSPORT: 1.01,
}

/** Classes where L2 is enabled — the only ones that cost a model download. */
export function enabledL2Classes(): string[] {
  return Object.entries(L2_TAU)
    .filter(([, t]) => t <= 1.0)
    .map(([c]) => c)
}

/**
 * Whether the cascade should load and run L2 this cycle.
 *
 * Loading a 27 MB model to feed a layer that will admit nothing is the exact
 * waste that made the disabled layer still cost a 332 MB download before.
 */
export function l2Enabled(pressureAllowsL2: boolean): boolean {
  return pressureAllowsL2 && enabledL2Classes().length > 0
}

/** Admit one L2 span? */
export function admitL2(cls: string, score: number): boolean {
  const tau = L2_TAU[cls]
  return tau !== undefined && tau <= 1.0 && score >= tau
}

/** One line for the HUD, so a partially-enabled layer is not a mystery. */
export function l2Status(): string {
  const on = enabledL2Classes()
  return on.length
    ? `L2 active for: ${on.join(', ')} (measured: +11 PERSON found, precision cost on other classes)`
    : 'L2 off — see lib/l2policy.ts for the measured basis'
}
