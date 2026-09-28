# Veil — a privacy-preserving browser vision agent

A browser extension that reads the screen, **redacts sensitive data on the
device**, and sends only what is already safe. A local model finds the
sensitive data; a server VLM never sees a raw pixel or a real value.

The idea that matters: most teams build *screenshot → blur → upload*. Blur
destroys the semantics the server needs to act, and it isn't a privacy
guarantee — it's a cosmetic one. Veil runs **two perception channels with a
privacy gate between them**:

```
 DOM channel   →  structure, roles, field semantics        (zero pixels)
 PIXEL channel →  canvas / video / faces the DOM cannot see
                        │
                        ▼
            FUSION + FAIL-CLOSED GATE        ← the only exit
                        │
                        ▼
   server receives: structure + redacted frame + manifest
```

The gate is the product. If it cannot prove every detected item is covered, the
request is **aborted** and zero bytes leave.

---

## The headline, stated honestly

**We shipped a neural PII layer that measurably works, and we removed a claim
that was wrong in both directions.**

An earlier version of this README said the neural layer "does not work." That
was true of the two models we had tried and false as a conclusion. We had tested
`Xenova/bert-base-NER`, whose label space is genuinely `{PER, ORG, LOC, MISC}` —
CoNLL-2003 has no PII classes — and generalised from one model to all of them.
Checking the Hub instead of the assumption found a browser-loadable model with a
real PII label space:

**`onnx-community/bert-small-pii-detection-ONNX`** — 27.4 MB q8, Apache-2.0,
49 labels / 24 PII classes, and it runs:

```
"Contact Divya Banerjee at divya.banerjee@mailbox.net or 6117651412."
    B-PERSON         0.979
    B-EMAIL_ADDRESS  0.790
"Card 4111111111111111 ... SSN 123-45-6789."
    B-DATE_TIME      0.894
    B-US_SSN         0.383
```

### What it actually buys, measured

Naive union of L0+L1 and L2, on 268 ground-truth instances:

| | P | R | F1 | false positives |
|---|---|---|---|---|
| L0+L1 only | 0.938 | 0.679 | 0.788 | 12 |
| L2 alone | 0.060 | 0.597 | 0.109 | 2,496 |
| **naive union** | **0.090** | **0.903** | **0.164** | **2,444** |

**The naive cascade is catastrophic: F1 falls from 0.788 to 0.164.** L2 emits
~2,500 spans against 268 ground-truth instances. Measured per class, it does
add real recall in exactly three classes:

```
PERSON   42 -> 54   (+12)
EMAIL    40 -> 48   (+8)
PHONE    40 -> 56   (+16)
everything else: +0
```

So the shipping decision is per-class, and it lives in `lib/l2policy.ts` with
tests: **admit PERSON only**, at τ=0.99. Every other class stays at τ=1.01 — never
admitted.

The reasoning is asymmetric and it matters for a redaction tool: a false
positive costs one useless box, a false negative leaks a real value. We will
take the useless box. And EMAIL/PHONE are *not* enabled despite the recall
gain, because L1 already recovers 40/48 and 40/56 on those at precision 1.00,
while L2's contribution there arrives bundled with 2,444 false positives.

Three things worth stating plainly:

1. **The cascade does not improve overall F1.** Measured delta for a naive union
   is **−0.624**. We are not claiming a win we cannot show.
2. **PERSON recall is the one real, kept gain: 42/54 → 54/54** on the union, and
   the shipped PERSON-only policy retains 53/54. That is the class regex
   structurally cannot reach, so it is the class worth paying for.
3. **Two of our own bugs were found by measuring, not by reading.** The
   transformers.js API returns no character offsets, so a naive merge produced
   `start: -1` and empty text — our first two benchmark runs scored **zero**
   despite the model working. And the cascade harness still pointed at the
   rejected `bert-base-NER`, then swallowed an ONNX batch error in a bare
   `catch {}`, so the entire L2 column read 0. Both failures looked exactly
   like "the model found nothing".

---

## Measured results

Every number here comes from a script in `bench/`. Nothing is estimated.

### M2 — PII detection (L0 + L1), 20 synthetic forms, 268 GT instances

```
micro  P=0.982  R=0.799  F1=0.881   (tp=214 fp=4 fn=54)
macro  F1=0.784
fail-closed regions blanked: 4
```

A correction to an earlier claim: this was reported as **P=0.980** over "248
instances". Both numbers were wrong. The corpus had 268 instances (it registers
a free-text paragraph in every form but only labelled PERSON/EMAIL/PHONE inside
it, leaving a real postal address unlabelled), and the benchmark had been
scoring against incomplete ground truth. Chasing that also produced one bad
rule — a bare-6-digit-PIN address pattern that measured **precision 0.08** — so
it was deleted rather than kept at a lower score.

### M3 — redaction precision (pixel channel)

```
pixel GT instances with exact boxes : 12
coverage IoU > 0                    : 12/12 (100%)
recoverability leakage (PROXY)     : 0/12 (0.0%)
mean box IoU                        : 0.045
```

The mean IoU is low **by construction** and that is not a defect: it compares a
520×160 whole-element fail-closed box against a ~100×28 text line. The numbers
that matter are coverage (12/12) and leakage (0/12). Fail-closed deliberately
trades box tightness for coverage.

The recoverability check is a **PROXY, not OCR** — it runs L1 regex over the
redacted region, so it catches a readable card number and cannot catch a
recognisable face. An exact rate needs Tesseract or an OCR VLM in the loop. We
did not want to publish a number that implied more than we measured.

### L3 — canvas coverage

```
canvases measured : 4
PII lines drawn   : 12
covered by region : 12  (100.0%)
detector cost     : 9.6 ms/canvas
```

Measured in a real browser on a real `OffscreenCanvas` with genuinely rendered
text; `bench/make_l3_harness.py` inlines the actual `runL3Text` source so this
measures the shipped code rather than a copy. **9.6 ms/canvas.**

The previous figure was **4/16**, and reaching the number above took fixing three
things that each independently made the detector look worse than it was:

- The corpus labels this channel `pixels`, not `canvas`. An earlier harness
  filtered on `canvas`, matched nothing, and printed `0/0` — which reads like a
  pass and is worse, because it is a wrong number formatted as a good one.
- `runL3Text` was calling the **face** detector and relabelling every box `DATE`.
  Canvas text detection was literally "find a person".
- A bare `catch` reported `available: false`, so a crash was indistinguishable
  from a clean page.

There is still no learned text detector underneath: the region finder is a
geometric edge-density heuristic, and the OCR stage is `trocr-small-printed`
(136 MB q8) which we have **not** run in a browser. So this measures detection,
not recovery — a detected region is blanked, but whether a value inside it was
readable is not established.

### M5 — latency

```
CLIENT   L0+L1 per form     p50 17.94 ms   p95 19.36 ms
         frame-diff gate    p50 27.95 ms
         pseudonym minting  p50  0.02 ms
SERVER   round trip (no engine)  p50 2.0 ms   p95 4.2 ms   12/12 ok
T1 TTFT with vLLM             NOT MEASURED
```

The server figure is the **degraded** path — no GPU here, so it returns a
schema-valid `none` plan. It is a floor, not the T1 turn. ARCHITECTURE.md §8's
700 ms p50 stays a **design target**: this machine has no GPU and no VLM weights,
and inventing a number from the fallback would be a fabricated benchmark.

### Leakage — the number we would want judged on

```
DOM-channel values checked              : 232
1. TEXT — present in screen_state.json?  : 3 / 232   (1.3%)   all ADDRESS
2. BOX   — redaction box drawn?         : 9 / 232 uncovered (3.9%)
   ADDRESS×5, BANK_ACCOUNT×4
```

A value can fail either channel independently, so both are reported. The three
text leaks are addresses of the form `171, Sector 18, Pune 411001` — a
house-number/token/**number**/**city**/PIN shape that a regex can separate from
ordinary prose only with difficulty, and we stopped widening it once the pattern
started costing precision. They are caught by the **fail-closed rule** instead:
the address is inside a form whose element is redacted on the pixel channel, so
the value is blanked in the frame even though its text reached the payload.

Getting here took three attempts, and each earlier version was confidently wrong:

1. The first audit searched `body.textContent`, which never contains an
   `<input value>`. It examined **104 of 212** instances and reported a clean 0%
   with an address still in the payload.
2. The second inverted the error and manufactured 90% — it searched a payload
   that by contract cannot carry values for flagged nodes.
3. The third was correct in structure but under-counted, because the corpus had
   been missing ADDRESS ground truth for the address in every summary paragraph.

Full write-up in `bench/measure_leakage.ts`.

---

## Threat model

**What leaves the device:** a pruned DOM tree with pseudonymized labels, a
redacted frame, and a manifest of what was removed. Never a raw pixel, never a
real value.

**What an attacker gets:** a redacted frame plus page structure. Enough to act
on the page, not enough to identify the person.

**Page-text prompt injection.** A malicious page can put text that reads like
an instruction. Mitigations: all page text is treated as untrusted *data*, never
as instructions; the system preamble states that `[TYPE_n]` tokens are stable
pseudonyms whose real values must never be requested or inferred; and anything
destructive (`submit`, `send`, `pay`, `delete`) requires a user confirmation
that the page cannot trigger.

**What the manifest digest is not.** It is a non-cryptographic content digest
bound to the frame hash — it detects corruption, not forgery. An earlier
version called it an HMAC; it was not one, and a client-side key could not be a
real boundary anyway. See `signManifest` in `redact.ts`.

**Uninspectable regions.** A cross-origin frame that refuses injection, a
`<canvas>`, a `<video>`, and a sealed shadow host are all classified
`OPAQUE_REGION` and **redacted whole**. We cannot redact what we cannot see, so
we do not send it. The gate aborts if any such region would ship uncovered.

---

## Model cards

| id | model | size | licence | where | measured |
|---|---|---|---|---|---|
| L2 PII | `onnx-community/bert-small-pii-detection-ONNX` | 27.4 MB q8 | Apache-2.0 | client, WebGPU | yes |
| L3 faces | `onnx-community/detr-resnet-50-ONNX` | 43 MB | Apache-2.0 | client, WebGPU/WASM | label space only |
| L3 OCR | `Xenova/trocr-small-printed` | 136 MB q8 | — | client, WASM | no |

### Two negative results we are publishing

**There is no small browser-loadable face detector.** We checked 1000
`onnx-community` repos, 200 `object-detection` + `transformers.js` results, and
the popular community face YOLOs — which ship **zero** `.onnx` files despite
high download counts. So L3 uses COCO `person` and pixelates the whole person
box, which is a superset of a face and therefore the safe direction.

**There is no browser-loadable text detector either.** No DBNet/EAST/CRAFT
export exists on the Hub. The canvas text pass is a geometric edge-density
region finder — a heuristic, labelled as one.

Both of these were previously mis-stated in the opposite direction: the code
claimed a "3 MB NMS-free face detector" that was in fact a 39 MB COCO detector
with no face class, and a `runL3Text` that called the *face* detector and
relabelled every box `DATE`. Neither was caught by a test, because the model
ids resolved and the pipeline tasks were valid. Checking the Hub is what
surfaced it. Recorded in `MODEL_FINDINGS` (`models.ts`).

---

## Capability matrix

| capability | Chrome | Firefox | notes |
|---|---|---|---|
| WebGPU | yes | Win only (141+) | WASM fallback is mandatory, not optional |
| `tabCapture` | yes | yes | default path; audio re-routed to AudioContext |
| `captureVisibleTab` | ≤2 calls/s | varies | polled ≤1.5 Hz behind the frame-diff gate |
| Region Capture | yes | partial | graceful no-op where unsupported |
| Compute Pressure | yes | no | cascade downshifts instead |
| Prompt API (tier-0) | 138+ | no | feature-detected; UI affordance hidden if absent |

---

## Running it

```bash
# 1. bench harness — every number in this README
./.venv/Scripts/python.exe bench/gen_synthetic.py        # regenerate corpus
./.venv/Scripts/python.exe bench/test_contract.py       # wire-format check
./.venv/Scripts/python.exe bench/test_server.py         # 17 server checks
cd extension && npx vitest run && npx wxt build         # 162 tests, both targets

# 2. server
./.venv/Scripts/python.exe -m uvicorn server.app:app --port 8000
#    (docker compose up for vLLM + weights)

# 3. extension — load unpacked from extension/.output/chrome-mv3
```

Benchmarks that need a browser (the L3 canvas measurement) generate a page you
open directly; `bench/l3_canvas.html` is self-contained.

---

## Honest failure notes

- **L2 does not improve F1.** It ships for PERSON only, and the cascade-delta
  table has a second column of zeroes on purpose. Claiming otherwise would be
  the easy lie.
- **A wire-format break shipped with 17/17 server tests passing.** The server's
  `RedactionModel` declared `pixel_derived`; the extension emits `pixelDerived`.
  Every real request was rejected with HTTP 422, and the suite never caught it
  because its fixtures had been written in the server's own spelling — it was
  testing the server against itself. `bench/test_contract.py` now derives the
  fixture from the client's Zod schema and fails on any drift.
- **M1 (40-task visual accuracy) and a true OCR recoverability rate are not
  measured.** They stay NOT MEASURED. The `tasks.json` suite exists; the runner
  does not yet drive a real browser against observable state.
- **T1 latency is a design target**, not a measurement. See M5 above.
- **The recoverability proxy is not OCR** and would not catch a recognisable
  face. M3's 0% leak rate is a regex-over-the-redacted-region check.
- **L3 detection ≠ L3 recovery.** Canvas regions are found and blanked, but the
  OCR stage (`trocr-small-printed`, 136 MB) has never been run in a browser, so
  we cannot claim the recovered string was ever checked.
- **Detecting a sealed shadow root is a heuristic.** There is no API for it; we
  infer it from a custom element with no open root, no light children, and a
  real painted box. It will occasionally blank a harmless web component.
- **Tier-0 is not implemented.** The Prompt API is feature-detected but the local
  answering path is not wired, so "zero network requests" is a design claim and
  not a measured one.
- **L2 truncates at 200 characters per element** to fit the model's 512-token
  window. A longer PII value inside a very long paragraph would be missed.
- **`capture_screenshot` and several browser APIs cannot be automated** — the
  permission dialogs and the tab-capture prompt need a human. Those paths are
  stubbed behind interfaces and flagged for manual verification.
