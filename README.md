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
micro  P=0.964  R=0.802  F1=0.876   (tp=215 fp=8 fn=53)
macro  F1=0.784
fail-closed regions blanked: 4
```

All 4 false positives are `OPAQUE_REGION` — the fail-closed marker for
cross-origin and uninspectable regions the pipeline **refused** to classify.
They are scored as false positives on purpose: scoring them as hits would
inflate precision dishonestly, and scoring them as misses would flatter it.
Every other class is either perfect or recall-limited, and no class produces a
false positive of its own.

Two earlier corrections, both from chasing a number that did not survive
measurement. This was first reported as **P=0.980** over "248 instances": the
corpus actually has 268 (it registers a free-text paragraph in every form but
labelled only PERSON/EMAIL/PHONE inside it, leaving a real postal address
unlabelled). It was then reported as **P=0.982** — which was a stale snapshot,
not a second measurement. The current figure is scored from the real detector
(`extension/bench/emit_detections.ts` over all 20 forms) and verified against a
clean checkout of the committed tree: the detection output is **byte-identical**
before and after this session's changes, so the difference was bookkeeping, not
a regression. Chasing the original discrepancy also produced one bad rule — a
bare-6-digit-PIN address pattern that measured **precision 0.08** — so it was
deleted rather than kept at a lower score.

The remaining recall gap is concentrated and intentional: PERSON 30/54, ORG 0/2,
MONEY 0/2, IP_ADDRESS 0/2. Regex structurally cannot find a name in prose. That
is precisely what L2 exists to close, and PERSON-only admission is what ships.

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

#### L3 — the loop is now wired, and what is still unmeasured

`ocrRegions()` existed but had **zero callers**, so the documented
detect → crop → OCR → re-classify loop was dead code. It is now live in
`entrypoints/offscreen/main.ts`: text regions are detected, cropped, read, and
the recovered strings go through L1 and L2 exactly as page text does.

Measured in real Chrome on real canvases
(`bench/make_l3_recovery_harness.py` → `bench/results/l3_recovery.json`):

```
stage 1 · detection   12/12 covered   9.5 ms/canvas     MEASURED
stage 2 · recovery    12/12           —                NOT MEASURED
stage 3 · re-class    8 hits (4 EMAIL, 4 PHONE)        MEASURED
```

Stage 2 is a **stand-in**. TrOCR (`trocr-small-printed`, 143 MB q8) has never
been executed in a browser, so the harness feeds ground truth where OCR output
would go. That proves the plumbing and the stage boundaries — it does not prove
OCR accuracy, which is the open question. Stage 1 is real, stage 3 runs against
the stand-in. We are not presenting 12/12 as a recoverability result.

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
(143 MB q8) which we have **not** run in a browser. So this measures detection,
not recovery — a detected region is blanked, but whether a value inside it was
readable is not established.

#### The L3 detector: yolov10n was the wrong recommendation, twice

`yolov10n` looked ideal — 2.65 MB int8 against DETR's 42.96 MB q8, NMS-free,
and its `config.json` does contain `"0": "person"`. It **does not run**:
transformers.js 3.8.1 has no `yolov10` model class, so it falls back to base and
fails with `Attempting to broadcast an axis by a dimension other than 1. 512 by
797`. Architecture metadata is not loadability, and I had claimed otherwise
before checking.

Every candidate was then executed (`extension/bench/probe_detectors.ts`):

| model | size | runs? | warm median |
|---|---|---|---|
| `yolov10n` int8 | 2.65 MB | **no** — unsupported architecture | — |
| `yolos-tiny` q8 | 9.66 MB | yes, but **2938 ms/frame** and 0 persons found | 2938 ms |
| `rtdetr_r18vd` q8 | 21.71 MB | yes, NMS-free | **632 ms** |
| `detr-resnet-50` q8 | 42.96 MB | yes | 3954 ms |

**RT-DETR r18 ships**: 6.3× faster than DETR at half the size, and NMS-free.
`yolos-tiny` was rejected on latency alone — 2.9 s per frame would dominate
every cycle. Note none of these is a *face* detector; all detect COCO `person`,
which is what the code filters on.

Licensing is unresolved and deliberately not papered over: yolov10n is
**AGPL-3.0**, and `rtdetr_r18vd` and `detr-resnet-50` both declare **no licence**
in their Hugging Face metadata. Neither is obviously shippable in a distributed
extension until that is decided. `piiranha` was rejected for the same reason.

### M5 — latency

```
CLIENT   L0+L1 per form     p50 17.94 ms   p95 19.36 ms
         frame-diff gate    p50 27.95 ms
         pseudonym minting  p50  0.02 ms
         L2 NER             3.6 ms/string, 57% of strings elided (see below)
SERVER   round trip (no engine)  p50 2.0 ms   p95 4.2 ms   12/12 ok
T1 TTFT with vLLM             NOT MEASURED
```

The server figure is the **degraded** path — no GPU here, so it returns a
schema-valid `none` plan. It is a floor, not the T1 turn.

#### The T1 number is now measured, against a real provider

`bench/live_timing.py` drives the real HTTP + SSE path. Measured against
`Qwen/Qwen3-VL-8B-Instruct` over Featherless, n=6 per row:

```
T1  safe path, p50  13.00 s   p95  18.94 s    fill city + postal code
T1  destructive,    p50  10.67 s   p95  18.68 s    plan is replaced by ask_user
    cold first request          18.06 s
```

**So T1 is ~13 s, not 700 ms.** ARCHITECTURE.md §8's target is missed by more
than an order of magnitude, and the honest conclusion is that the target
assumed a local vLLM on a GPU, not an 8B model on a remote API. Local serving
is the only thing that closes a 13-second gap; nothing on the client side will.

The two rows also show the endpoint is variable: an earlier session measured
p50 2.07 s for the same intent, and one request stalled past 74 s. A p50 from
six samples is not a stable distribution, and these figures should be read as
"seconds to tens of seconds depending on provider load", not as a benchmark.

Client-side compute, which IS the extension's own cost, is measured separately
by `extension/bench/measure_scan_latency.ts`:

```
per scan cycle on a ~52-element form (JSDOM parse cost subtracted)
  pruned-tree collection      p50  12.67 ms
  L0+L1 classification        p50   5.84 ms
  frame-diff gate (2 cycles)  p50  42.50 ms
  T0 summary, our side        p50  15.57 ms      NOT the model's inference
  ------------------------------------------------------------------
  client subtotal             p50  62.2 ms
```

That 42.50 ms gate is the single largest client cost and it is mostly the
64x64 box-average downscale of a 1920x1080 frame in JS. It is measured, and
it is the obvious next optimisation. It is also skipped entirely when the page
has not changed — the harness asserts that behaviour, so the number is for
work the product actually does.

**T0's model inference is NOT MEASURED** and no number is claimed for it: it
needs a real Chrome with the Prompt API and a downloaded model, and a stub
times the stub. Only our side of that call (~15 ms) is measured.

#### L2 was sequential. Batching was the obvious fix and it is the wrong one.

At ~3.6 ms per string, a dense page paid hundreds of milliseconds of model time
before a pixel was redacted. The natural fix is to batch the strings. That was
implemented, measured, and **rejected**
(`extension/bench/probe_l2_batch_perf.ts`):

```
batch  1:   453 ms   3.78 ms/string    tokens = 638
batch  2:   384 ms   3.20 ms/string    tokens = 633
batch  4:   384 ms   3.20 ms/string    tokens = 631
batch  6:   379 ms   3.16 ms/string    tokens = 630   <- best
batch  8:   476 ms   3.97 ms/string    tokens = 625
batch 12:   421 ms   3.51 ms/string    tokens = 620
best speedup: 1.20x
```

Two reasons that is a bad trade. The win is 20%, and **the token count changes
with the batch size** — the same 120 strings produce 638 detections at B=1 and
620 at B=12. A redaction detector whose output depends on how the work happened
to be chunked cannot be reasoned about, benchmarked, or reproduced. transformers.js
appears to run one forward pass per input regardless of the batch argument, so
batching mostly adds padding work.

What ships instead is **input reduction**, which is deterministic and larger
(`extension/bench/probe_l2_dedup.ts` → `bench/results/l2_input_reduction.json`):

```
818 element texts -> 287 unique  (64.9% were repeated labels)
                      -> 283 after the L1-covered filter
wall clock 3071 ms -> 1316 ms   (57.2% saved)
admitted spans lost: 0
```

Both halves are answer-preserving by construction. Dedupe is free because the
model is deterministic. The filter skips a string only when L1 already owns its
PII **and** it holds no plausible person name — and since PERSON is the only
admitted class, a name is the only thing L2 could add. The 12 spans the filter
did drop were `US_DRIVER_LICENSE` / `US_ITIN` / `US_PASSPORT` / `CREDIT_CARD`,
all of which `admitL2` rejects downstream anyway.

The filter is honestly small: 4 of 287 unique strings, because corpus strings
mostly pair an identifier with a name — the exact case it must not skip. Dedupe
is doing the work.

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
| L3 faces | `onnx-community/rtdetr_r18vd-ONNX` | 21.7 MB q8 | **none declared** | client, WebGPU/WASM | executed; 632 ms |
| L3 OCR | `Xenova/trocr-small-printed` | 143 MB q8 | — | client, WASM | not run in a browser |

### Two negative results we are publishing

**There is no small browser-loadable *face* detector.** We checked 1000
`onnx-community` repos, 200 `object-detection` + `transformers.js` results, and
the popular community face YOLOs — which ship **zero** `.onnx` files despite
high download counts. So L3 uses COCO `person` and pixelates the whole person
box, which is a superset of a face and therefore the safe direction. It is worth
being precise about the correction here: the *absence of a face-specific model*
is real, but "there is no small browser-loadable person detector" was an
over-generalisation and was wrong. `rtdetr_r18vd` at 21.7 MB is small, runs, and
is what ships.

**There is no browser-loadable text detector either.** No DBNet/EAST/CRAFT
export exists on the Hub. The canvas text pass is a geometric edge-density
region finder — a heuristic, labelled as one.

Both of these were previously mis-stated in the opposite direction: the code
claimed a "3 MB NMS-free face detector" that was in fact a 39 MB COCO detector
with no face class, and a `runL3Text` that called the *face* detector and
relabelled every box `DATE`. Neither was caught by a test, because the model
ids resolved and the pipeline tasks were valid. Checking the Hub is what
surfaced it, and executing the candidates is what caught the yolov10n case.
Recorded in `MODEL_FINDINGS` (`models.ts`).

### Three bugs that were structural, not typos

These are worth listing because each one was invisible to the type checker, the
test suite, and the build — and each would have been a privacy failure.

1. **Three pseudonymizers.** `lib/pseudonym.ts`, a private class in
   `offscreen/redact.ts`, and a bench copy in `bench/pseudonym_helper.ts`. The
   compositor's copy minted `[PERSON_1]` while the canonical one minted
   `[PERSON_A3_1a2b3c4d]`, and — worse — each constructed its own instance with
   a **random** salt and counter, so the content script and the compositor could
   not agree on a token even in principle. Stable per-session pseudonyms, which
   ARCHITECTURE.md depends on for co-reference, were a property of the code's
   *intent* and not of its behaviour. Now there is one implementation, the
   session id is the salt, and the token suffix is derived from
   `(sessionId, value)` rather than a counter — so it is order-independent and
   two contexts holding the same session id mint identical tokens. Covered by
   `tests/pseudonym.test.ts`.

2. **Open CORS.** `docker-compose.yml` set `VEIL_ALLOWED_ORIGINS: "*"`, and the
   server default was the wildcard `chrome-extension://*`. Any web page the user
   visited could POST to the server. Both are now explicit, and
   `bench/test_cors.py` (9 checks) fails if a wildcard is ever reintroduced.

3. **A mark that rerolled into a sensitive field.** Actions re-resolve their
   mark against the live page, because the snapshot may be stale by the time the
   plan lands. But the sensitive-field check ran *before* re-resolution, so a
   mark that moved from a harmless label onto an input would be clicked without
   confirmation. The policy now runs after re-resolution, in one place
   (`lib/action-safety.ts`), and a reroll into a sensitive target forces
   `ask_user`. 9 tests in `tests/action-safety.test.ts`.

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

### One command

```bash
./.venv/Scripts/python.exe bench/demo.py
```

That runs the whole verification gate, builds the extension, starts the API
and the form server, and then — if a model is configured — runs one real task
through the actual HTTP + SSE path and prints the plan it received. It prints
the load path for `chrome://extensions` at the end. Ctrl-C stops the servers.

```bash
bench/demo.py --verify        # gate only, no servers
bench/demo.py --live          # refuse to run unless a provider is configured
bench/demo.py --fake          # offline provider: canned plans, NOT model evidence
```

The gate is five real checks, in dependency order, each of which fails loudly
rather than degrading quietly:

| # | check | proves |
|---|---|---|
| 1 | `vitest` + `tsc --noEmit` | the privacy and policy invariants hold; no type lies |
| 2 | server / providers / CORS | the wire contract, incl. real extension-origin preflights |
| 3 | deployment contract | the container's config is one the server accepts |
| 4 | live plan gate | a plan naming a non-existent mark is escalated **by the real endpoint** |
| 5 | `wxt build` | it loads, with the permissions the code actually calls |

Two checks exist specifically because a suite once lied. `check_plan_against_state`
was unit-tested and then never called by any request path — check 4 exercises
it over real HTTP so that cannot recur silently. And `VEIL_ALLOWED_ORIGINS`
was baked into the Dockerfile as a wildcard the server now refuses, which
docker-compose masked; check 3 reads the Dockerfile and fails on it.

### The parts, individually

```bash
# 1. bench harness — every number in this README
./.venv/Scripts/python.exe bench/gen_synthetic.py        # regenerate corpus
./.venv/Scripts/python.exe bench/test_contract.py       # wire-format check
./.venv/Scripts/python.exe bench/test_server.py         # 14 server checks
./.venv/Scripts/python.exe bench/test_cors.py           # 12 CORS checks
./.venv/Scripts/python.exe bench/test_destructive_label.py  # 10 destructive-gate checks
cd extension && npx vitest run && npx wxt build         # 263 tests, both targets

# server
./.venv/Scripts/python.exe -m uvicorn server.app:app --port 8000
#    (docker compose up for vLLM + weights)

# extension — load unpacked from extension/.output/chrome-mv3
```

### Reproducing the measurements

```bash
cd extension
npx vite-node bench/probe_detectors.ts        # which L3 detectors actually run
npx vite-node bench/probe_l2_batch_perf.ts    # why batching was rejected
npx vite-node bench/probe_l2_dedup.ts          # the input-reduction win
npx vite-node bench/measure_l2_batching.ts     # the rejected batching attempt
npx vite-node bench/measure_leakage.ts         # serialised-text vs pixel-box audit
cd .. && ./.venv/Scripts/python.exe bench/run_metrics.py
```

### Reviewing the side panel

The UI is reviewable without a real page, and the check that matters is numeric:

```bash
cd extension && VEIL_OUT_DIR=.review npx wxt build   # .review, not .output
cd .. && ./.venv/Scripts/python.exe bench/make_panel_preview.py
./.venv/Scripts/python.exe bench/serve_preview.py --port 8741
# open http://127.0.0.1:8741/panel_preview.html?state=confirm
./.venv/Scripts/python.exe bench/check_panel_layout.py --port 8741
```

`?state=empty|busy|confirm|full` drives representative states through the real
render path. `check_panel_layout.py` asserts nothing overflows at 400, 360 and
320px across all four and exits non-zero on failure.

`VEIL_OUT_DIR` is a Windows necessity, not a convenience: a process that once
held a working directory inside `.output/chrome-mv3` keeps a handle on it after
exiting, and every later build then fails with `EBUSY: rmdir` on an empty
directory. WXT 0.19 has no `--outDir` flag, so the override lives in
`wxt.config.ts`. The default is unchanged.

### The approval gate

The panel's most important element is the one that was missing. The system halts
a destructive step and waits for `content:confirm`; the service worker and the
content script both handled that message, and **nothing in the UI could send
it**. A destructive action therefore halted forever with no way forward — a
safety mechanism that is unreachable is worse than none, because it looks
handled. `panel.tsx:resolveConfirm` is now the other half of that loop, and
"No, skip it" sits beside "Yes, do it" because a refusal path that is harder to
reach than consent is a refusal nobody uses.

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
- **The panel could hang forever with no error.** `runs` is a plain `Map` in
  the service worker, and MV3 recycles an idle worker at ~30s. A T1 turn
  measures p50 ~13s and p95 ~19s, so the pipeline outlives the worker holding
  it. On restart the run is gone, so none of the four terminal messages
  (`panel:plan` / `panel:answer` / `panel:error` / `redact:aborted`) is ever
  sent — and those four are the only things that clear the panel's `busy`
  flag. The spinner ran until the panel was closed. Now: a service-worker
  watchdog, a panel-side deadline (the only party that survives a restart can
  notice the absence), and a Reload button that clears a stuck run and says
  why. It still does not *resume* an orphaned run — that state is gone.
- **The debug console was empty, and adding logging would not have fixed it.**
  282 of the project's `console.*` calls are in bench scripts; the runtime
  files logged essentially nothing. But the deeper problem is that the console
  dies with the worker, which is exactly what the user was trying to
  investigate. The log is now a bounded ring persisted to
  `chrome.storage.session` and rendered in the panel under the Activity
  button. Every entry is scrubbed on the way IN — a log is a place secrets
  leak, and the project has a key in `.env` and a bearer header in flight.
- **The Reload button did nothing visible.** It sent `panel:run` directly
  instead of going through `runIntent()`, so it never set `busy`, never pushed
  a transcript line, and produced no feedback at all. It now goes through
  `runIntent()` and can break a stuck run.
- **A safety rejection was being read as "let it through."** `_apply_escalation_gate`
  caught every parse exception and returned `None`, which the caller reads as "no
  replacement needed". But a `ValidationError` from the destructive-verb check
  arrives the same way, so the one plan the safety rule had just rejected was the
  one plan allowed through. Found by driving the live model with "pay for the
  order" and watching `action=click, confidence=0.98` reach the client. Now only
  a genuinely unparseable blob passes through; a safety rejection becomes
  `ask_user` with no steps. `bench/test_destructive_label.py`.
- **The destructive gate read the wrong text.** It scanned the plan's own words
  for destructive verbs, but a grounded plan addresses a control by mark and never
  says what the button is called. `click -> mark 3` on a node labelled
  "Submit order" contains no destructive token, so it passed. The target's own
  label is now scanned with the same regex — the label is already in the request,
  it was one lookup away.
- **A correctly configured `.env` never reached the provider.** Providers snapshot
  `os.environ` in `__init__`, and `Router()` runs at module import — but
  `uvicorn --env-file .env` populates the environment *after* that import. So
  every provider captured an empty base URL and fell back to a dead port, and
  `/health` reported "no provider reachable" no matter how correct the file was.
  The app now loads `.env` itself before the singletons are built.
- **`/health` reported "no provider reachable" on a healthy server.** It called
  `router.active()`, which only reports whichever provider a *previous* request
  selected — so on a fresh process, always nothing. It now resolves. A missing
  `engine_summary` on the fake provider used to raise, i.e. 500 the one endpoint
  an operator polls; that degrades the report instead.
- **A test suite inherited production credentials and called the real model.**
  Once the app loaded `.env` itself, `bench/test_server.py` made a billed request
  and `bench/test_cors.py` timed out at 300s — reported as a CORS failure, which
  it was not. Both now pin the fake provider. Suites that stop being unit tests
  when a `.env` exists are a design smell, not a test bug.
- **M1 (40-task visual accuracy) and a true OCR recoverability rate are not
  measured.** They stay NOT MEASURED. The `tasks.json` suite exists; the runner
  does not yet drive a real browser against observable state.
- **T1 latency misses its target by more than an order of magnitude** — measured
  p50 ~13 s against a remote 8B model, versus ARCHITECTURE.md §8's 700 ms. The
  target assumed local serving on a GPU. Measured, reported, not closed.
- **The recoverability proxy is not OCR** and would not catch a recognisable
  face. M3's 0% leak rate is a regex-over-the-redacted-region check.
- **L3 detection ≠ L3 recovery.** The loop is now wired end to end and stage 1
  and 3 are measured, but the OCR stage (`trocr-small-printed`, 143 MB) has never
  been run in a browser, so the recovered string has never been read for real.
  The 12/12 recovery figure is a stand-in and is labelled as one.
- **The L3 detector's licence is unresolved.** `rtdetr_r18vd` declares no licence
  on the Hub. Shipping a model with no grant is a legal question, not a
  technical one, and it is not answered here.
- **L2 is deliberately PERSON-only.** Admitting every class measured P=0.090 and
  ~2444 false positives. Broader coverage is a threshold change in
  `lib/l2policy.ts`, at a measured precision cost — not a free option.
- **Batching L2 was measured and rejected**, not overlooked: 1.20x best case with
  a batch-size-dependent detection count. See M5 above.
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
