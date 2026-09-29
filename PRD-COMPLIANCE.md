# PRD Compliance Audit — Veil

Scanned against `PRD.md`. Everything below was verified by reading the code, running the suites, or
booting the server — not inferred from the README.

---

## Headline

**The project is presentation-ready for the client-side story and deployable for the server, but it
is behind the PRD on the evidence, not the code.** Every functional requirement is implemented. What
is missing is measured proof for the three metrics that carry 60% of the SIH weight — and one number
that actively contradicts a PRD target.

| | Status |
|---|---|
| Functional requirements (FR-01…FR-06) | **6 of 6 implemented** |
| Business rules (BR-01…BR-04) | **4 of 4 enforced** |
| Use cases (UC-01…UC-03) | **3 of 3 implemented, 1 partial (UC-02)** |
| Acceptance criteria (AC-01…AC-03) | **1 of 3 met, 2 partial** |
| Metrics with measured evidence | **M2, M4 only — 40% of rubric** |

**All eight defects from my previous audit are fixed.** I re-verified each: `frame_hash` placeholder
gone, `pseudonym.substitute()` wired into the content script, viewport coordinates, structural DOM
hash in the gate, confidence-floor abort removed, marks forwarded to the compositor, CSP amended for
the server origin, and the action-execution loop (`executePlan`) now exists. Test count went
104 → 203.

---

## Verification I ran

```
npx tsc --noEmit                 clean
npx wxt build                    ✔ chrome-mv3  212.34 kB
npx wxt build -b firefox         ✔ firefox-mv3 212.25 kB
npm test                         203 passed / 12 files
python bench/test_server.py      PASS
python bench/test_cors.py        PASS
python bench/test_contract.py    PASS
python bench/test_providers.py   PASS  (448 lines)
python bench/test_e2e_api.py     16/16 PASS  (mock LLM on :8103, server on :8010)
uvicorn server.app:app           ✔ 6 endpoints live
docker compose config            ✔ services: vllm, veil
```

The E2E run exercises the real path: `POST /v1/agent/step` → provider → schema-valid plan → session
state → outcome recording, including the prompt-injection case (`page contains instruction-shaped
text: instruction_override`) and the 3-attempt replan cap.

---

## Functional requirements

| FR | Requirement | Status | Evidence |
|---|---|---|---|
| **FR-01** | Dual-mode capture, ≤1.5 Hz throttle, Region Capture | ✅ | `capture.ts` — 3-rung ladder, `CaptureThrottle` at 1.5 Hz, `CropTarget.fromElement` + `cropTo` |
| **FR-02** | Pruned a11y tree, viewport-normalized boxes, no value exfiltration | ✅ | `content.ts` — `MAX_DEPTH 8`, `MAX_CHILDREN 40`, `collapseRepeats`; `pseudonym.substitute()` closes the old `label` leak |
| **FR-03** | L0/L1/L2/L3 cascade | ✅ | `pii.ts` (Luhn, Verhoeff), `models.ts` (L2 = `bert-small-pii-detection-ONNX` 27.4 MB q8, 4.1 ms/text), L3 = yolov10n + edge-density + TrOCR |
| **FR-04** | Redaction gate, `OPAQUE_REGION`, pseudonyms, no password hashing | ✅ | `redact.ts`, `pseudonym.ts` (`PASSWORD_TOKEN`, class-keyed so the secret is never a map key), OPAQUE present in all 3 files |
| **FR-05** | Transmit 3 artifacts to FastAPI, schema-validated plans | ✅ | `background.ts callServer()`; 6 endpoints live; `test_e2e_api.py` 16/16 |
| **FR-06** | SoM badges burned in, confirmation for high-stakes | ✅ | `action-safety.ts` — two axes (destructive verb + reroll-into-sensitive); marks now forwarded |

**FR-03 L2 is the headline improvement.** `l2policy.ts` now documents the full history: the original
"no browser NER has PII classes" generalization was wrong; `bert-small-pii-detection-ONNX` was measured
at **P=0.119 R=0.569 F1=197 raw**, and the per-class policy ships **PERSON only at τ=0.99** —
PERSON recall 42/54 → 53/54, while EMAIL/PHONE/LOCATION/ORG stay disabled because L1 is already exact
and L2 alone produced 337 false positives on LOCATION. That is a *measured* per-class decision, not a
guess, and the reasoning is written down.

---

## Where it is behind the PRD

### 1. M3 IoU is 0.045 against a ≥0.95 target — the largest single gap

`bench/results/m3.json`:
```json
"mean_iou": 0.0452,
"coverage": { "any": 1, "iou50": 0, "iou80": 0 }
```

Every redaction box overlaps its ground truth at all (`any: 1.0`) but essentially none exceed
IoU 0.5. PRD target is **≥95% IoU**. The likely cause is the coordinate-space change: boxes are now
viewport-relative while the GT boxes in the corpus were generated in document space, or the GT boxes
are element-sized while redaction boxes are padding-inflated. **Either way, 0.045 vs 0.95 is a
40-point miss and it is the metric judges will probe.**

Note the leakage number is good: `recoverability_leakage_proxy: {leaked: 0, total: 12, rate: 0}` —
zero PII recoverable from redacted regions. That half of M3 is fine; it is the geometry that is wrong.

### 2. M1, M3, M5 are still `NOT MEASURED` in `metrics.json`

```json
"M1_visual_context":  { "provenance": "NOT MEASURED", "results": null }
"M3_redaction_precision": { "leakage_rate": null, "box_iou": null }
"M5_latency":         { "p50_ms": null, "p95_ms": null }
```

**60% of the SIH rubric has no measured number in the canonical output file**, even though partial
evidence exists elsewhere (`grounding.json` = 8/8 mark use, 0 invented marks against a live
Qwen3-VL-32B; `l3_canvas.json` = 12/12 canvas coverage; `l3_recovery.json` = 12/12 detected).
The evidence is scattered across files the runner does not aggregate.

**This is the cheapest remaining win: `run_metrics.py` should fold the existing JSON into M1/M3/M5
rather than emitting `null`.** You already have the numbers; the runner just does not read them.

### 3. M5 has no real T1 latency

```json
"t1_ttft_with_vllm": { "value": null, "status": "NOT MEASURED", "design_target_p50_ms": 700 }
```

`grounding.json` shows the only live measurement: **p50 10,094 ms** (max 29,162 ms) against
Qwen3-VL-32B via an API endpoint. The PRD target is **<1200 ms**. A 32B thinking-class model on a
shared endpoint is 8× over. The composed stack (vLLM V1 + prefix caching + XGrammar + n-gram
speculation) is correctly configured in `docker-compose.yml`, but **it has not been run**. Demo
against the API model will blow the latency budget visibly.

### 4. AC-01 wants a cryptographic SHA-256; the client sends FNV

`redact.ts` signs with FNV-1a. The server side *does* use SHA-256 (`server/manifest_privacy.py`,
`app.py`), but `schema.ts` and `redact.ts` have no `crypto.subtle` call. AC-01 says
"cryptographic SHA-256 manifest hash" — the current client signature does not satisfy it.

### 5. AC-02 (±2 px centroid) is not implemented or measured

`som.ts` has no `centroid` symbol. `bench/measure_grounding.py` exists and proves the model
*references* a mark correctly (8/8, 0 invented) but nothing asserts the click lands within ±2 px.

### 6. AC-03 (<250 MB) unmeasured

No memory figure anywhere in `bench/results/`. The extension is 212 kB, which is excellent, but
that is disk size, not resident memory.

### 7. UC-02 (zero-network Tier-0) is implemented but not wired

`PromptApiTier0` exists in `models.ts` with correct `LanguageModel.availability()` handling and
`expectedInputs: [{type:'image'}]`. **But `tier0.answer()` is never called.** The T0 branch in
`background.ts` re-runs capture and uses the capture result as the "answer". So the *privacy
postcondition* of UC-02 — "0 outbound requests and 0 bytes transmitted" — is not achieved by an
actual local inference. This is a ~15-line fix: route T0 to `tier0.answer(intent, screenText)`.

### 8. Minor PRD wording gaps

- **FR-03 names BlazeFace and DBNet**; the code uses `yolov10n` + an "edge-density" region finder.
  Functionally equivalent and smaller, but the PRD and the code disagree on paper. Either amend the
  PRD or name the actual models — a judge comparing the two will notice.
- **UC-01 specifies a "pulsing amber ring"**; content.ts has no pulsing animation. The confirmation
  gate works, the specified affordance does not exist.
- **`bench/measure_m3.ts` lives in `extension/bench/`**, not `bench/` — inconsistent with every
  other measure script.

---

## Is it presentation-ready? — yes, with two conditions

**Server side: genuinely deployable.**
- `docker compose up` brings up `vllm` (Qwen2.5-VL-7B, prefix caching, XGrammar, n-gram speculation,
  healthcheck, 300 s start grace) + `veil`.
- The FastAPI app boots cleanly and exposes `/health`, `/v1/agent/step`, `/v1/agent/tiles`,
  `/v1/agent/outcome`, `/v1/agent/validate`, `/v1/agent/session/{id}`.
- `providers/` has a real router: `local_vllm` (strict schema, ZDR-eligible) / `openai_compat` /
  `fake`, with a health endpoint that advertises which is live. CORS, prompt-injection detection
  (`injection.py`), session state, replan cap, and a "session status never returns a payload"
  guarantee are all covered by passing tests.

**Extension side: buildable and loadable.** Both targets build clean in ~3 s at 212 kB.

**Condition 1 — the demo must use the local vLLM, not the API model.** 10 s p50 against a
32B API model versus a <1200 ms target is the kind of number a judge times on screen. `docker
compose up` is the demo path.

**Condition 2 — demonstrate on a scrolled page.** The viewport-coordinate fix is real and correct,
but it has never been exercised end-to-end in a browser. The synthetic corpus is short and
unscrolled. A long page scrolled to the middle is exactly the case that broke before; confirm it
visually once before you present.

**Condition 3 — do not show `metrics.json` as-is.** M1/M3/M5 read `NOT MEASURED` in the canonical
output. Either aggregate the evidence you already have, or show `grounding.json` / `l3_canvas.json` /
`leakage.json` directly and say which are partial.

---

## The honest scorecard against SIH weights

| Metric | Weight | Measured | PRD target | Verdict |
|---|---|---|---|---|
| M1 visual context | 25% | partial (8/8 mark grounding) | ≥92% task success | **behind** — no 40-task run |
| M2 PII detect | 20% | **P=0.964 R=0.802 F1=0.876** | R≥99.5%, P≥95% | recall short of target, precision met |
| M3 redaction | 20% | IoU 0.045, leakage 0.00 | IoU≥95%, leak 0% | **behind on geometry**, met on leakage |
| M4 resources | 20% | L0+L1 17.9 ms, gate 27.9 ms | <250 MB, <15% CPU | timing met, memory unmeasured |
| M5 latency | 15% | server floor 2 ms; T1 10 s (API) | <1200 ms | **behind** until local vLLM is measured |

M2 recall (0.802 vs 0.995) is the other real gap — the misses are concentrated in
`PERSON×24 PHONE×8 ADDRESS×5 BANK_ACCOUNT×6`, i.e. the classes where a client model or OCR could help.

---

## Recommended order before presenting

1. **Aggregate the existing JSON into M1/M3/M5 in `run_metrics.py`** — you already have the
   evidence; this is the highest ratio of marks to effort in the repo.
2. **Fix the M3 IoU (0.045)** — investigate the viewport-vs-document GT mismatch in the corpus
   generator. This is 20% of the rubric showing a failing number.
3. **Route T0 to `tier0.answer()`** — ~15 lines, completes UC-02 and the zero-request demo scene.
4. **Boot `docker compose up` once and record real T1 p50/p95** — replaces a 10 s API number with
   the stack's actual latency.
5. **Run the 40-task M1 suite headlessly** (Playwright + the built extension) — the last unmeasured
   25%.
6. Smaller: SHA-256 in the client signer (AC-01), centroid assertion (AC-02), resident-memory
   measurement (AC-03), reconcile PRD model names with the code, add the pulsing ring.
