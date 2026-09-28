# Veil — a privacy-preserving browser vision agent

A browser extension that reads the screen, **hides sensitive data on the
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

**The neural layer does not work, and we proved why instead of shipping it.**

We ran the real GLiNER PII model (349 MB downloaded) and the real fallback NER
against 248 ground-truth instances. Results:

| attempt | outcome |
|---|---|
| `onnx-community/gliner_multi_pii-v1` (332 MB, the architecture's preferred L2) | **rejected by transformers.js** — `Unsupported model type: gliner`. It cannot load in a browser runtime at all. |
| `Xenova/bert-base-NER` (109 MB, the documented fallback) | **loads, runs, and its entire label space is `{PER, ORG, LOC, MISC}`.** Given a literal email address it returns **no entities at all**. |

That is not a tuning problem. Those classes do not exist in CoNLL-2003's label
space, so no threshold and no prompt can produce them. Proof is in
`bench/diagnose_l2.ts`, which prints the raw model output for known PII strings.

**What we did with that finding:** rather than ship a decorative neural layer or
quietly lower a threshold, `bench/tune_thresholds.ts` ran the per-class
threshold search the architecture prescribes, and the measured optimum is
**τ = 1.01 for every class — that is, never admit an L2 span**:

```
  L2 label space actually emitted: PERSON, LOCATION, ORG, DATE
  GT classes with no L2 coverage: EMAIL, PHONE, DOB, PASSWORD, AADHAAR,
      PAN, CREDIT_CARD, IFSC, BANK_ACCOUNT, GSTIN, ADDRESS, FACE,
      API_KEY, MONEY, PASSPORT, DL, IP_ADDRESS

  L0+L1 only      P=0.954  R=0.669  F1=0.787
  tuned cascade   P=0.954  R=0.669  F1=0.787
  FINAL: L2 does NOT improve overall F1 (delta +0.000)
```

So L2 is wired up, benchmarked, and **disabled by policy**
(`lib/l2policy.ts`, with tests locking the decision in). The load-bearing
layers are L0 + L1.

A naive union fusion was also measured and it **loses badly** — recall rose to
0.774 while precision collapsed to 0.133, because hundreds of LOC/MISC spans
count as false positives. That is the measurement that justifies per-class
thresholds existing at all.

---

## Measured results

Every number came from a script in this repository. Where something is
unmeasured it says so, because an invented benchmark is worse than a missing one.

### M2 — PII detection (20% weight) · **MEASURED**

Real detector, real 20-form corpus, exact ground truth.
`python bench/run_metrics.py`

| | precision | recall | F1 |
|---|---|---|---|
| **micro** | **0.980** | **0.798** | **0.880** |
| macro | — | — | 0.767 |

Per class:

| class | P | R | F1 | | class | P | R | F1 |
|---|---|---|---|---|---|---|---|---|
| PASSWORD | 1.00 | 1.00 | 1.00 | | AADHAAR | 0.83 | 1.00 | 0.91 |
| CREDIT_CARD | 1.00 | 1.00 | 1.00 | | BANK_ACCOUNT | 1.00 | 0.40 | 0.57 |
| PAN / GSTIN / IFSC | 1.00 | 1.00 | 1.00 | | ADDRESS | 0.50 | 0.50 | 0.50 |
| DOB / DL / PASSPORT | 1.00 | 1.00 | 1.00 | | **PERSON** | 1.00 | **0.56** | 0.71 |
| API_KEY / FACE | 1.00 | 1.00 | 1.00 | | **ORG / MONEY / IP** | 0.00 | **0.00** | 0.00 |
| EMAIL | 1.00 | 0.92 | 0.96 | | | | |
| PHONE | 1.00 | 0.86 | 0.92 | | | | |

**By channel** — the most informative cut:

| channel | tp | fn | meaning |
|---|---|---|---|
| DOM | 190 | 34 | L0/L1 territory |
| pixels (canvas text) | 4 | 12 | needs L3 |
| attribute (`data-*`) | 4 | 0 | caught by L0 |
| **closed shadow** | **0** | **4** | unreachable without pixel geometry |

Zero of four on closed shadow roots, because L3 is not measured. That is the
honest state of the pixel channel.

### M4 — client resources (20% weight) · **CPU side MEASURED**

`cd extension && npx vite-node bench/measure_client_cpu.ts`

| workload | mean | p50 | p95 |
|---|---|---|---|
| L0+L1, per form (52 elements) | 18.25 ms | 17.94 | 19.36 |
| frame-diff gate, 1920×1080, 2 cycles | 29.02 ms | 27.95 | 37.69 |
| pseudonym minting, 5 values | 0.03 ms | 0.02 | 0.05 |

Projections for slower hardware are **estimates** (published single-thread
scores, roughly ±30% error):

| device class | factor | L0+L1 p50 | gate p50 | per cycle |
|---|---|---|---|---|
| this machine | ×1 | 17.9 ms | 27.9 ms | ~46 ms |
| modern laptop | ×1.8 | 32.3 ms | 50.3 ms | ~83 ms |
| integrated GPU only | ×2.5 | 44.9 ms | 69.9 ms | ~115 ms |
| low-end Chromebook | ×3.5 | 62.8 ms | 97.8 ms | ~161 ms |
| **budget 2015–2018 laptop** | **×4.5** | **80.7 ms** | **125.8 ms** | **~207 ms** |

Heap, idle CPU and download bytes are **NOT MEASURED**.

### M1 / M3 / M5 · **NOT MEASURED**

- **M1 (25%)** — 40-task suite defined in `bench/tasks.json` (7 tier-0, 9
  requiring confirmation); scoring needs a real browser session.
- **M3 (20%)** — box IoU and recoverability-based leakage rate need rendered
  redaction output. This is the metric nobody reports and the one that cannot
  be faked: drawing boxes is easy, making text unrecoverable is not.
- **M5 (15%)** — needs a running vLLM. The ~700 ms figure is a **design
  target**, deliberately kept out of the results table.

---

## Running on a small GPU

| layer | 800 MB VRAM? | why |
|---|---|---|
| L0 semantics | ✅ | attribute reads, ~0 ms |
| L1 regex + checksums | ✅ | ~1 ms, no GPU |
| frame-diff gate | ✅ | CPU |
| L2 NER | n/a | **disabled by measurement**, see above |
| L3 face/text detectors | ✅ | small models fit |
| SmolVLM audit | ❌ | ~260 MB, explicitly disabled |

On that machine Veil keeps high precision and reduced recall. `lib/device.ts`
derives this from reported VRAM/RAM/thread count instead of assuming a desktop,
and NER batch size scales with memory (a hardcoded batch of 64 is ~96 MB per
activation tensor and would OOM on exactly this hardware).

## Mobile

**Chrome on Android: the extension installs, but the pixel channel cannot
exist.** PII drawn in a canvas or video frame is only catchable by pixel
detectors. Without them Android is structure-only — a safety limitation, not a
bug, and the extension says so.

`tabCapture` and `offscreen` carry **no platform gate in Chromium's
`_api_features.json`**, so the platform-neutral reading is encouraging but the
Android embedder's support is **unverified**. `lib/device.ts` ships the runtime
probe that settles it on a real device.

**iOS/Safari: not a target.** No MV3 extension support.

---

## The hard invariants

Enforced structurally, each with a test.

| invariant | enforcement |
|---|---|
| **Raw pixels never reach the network** | the frame lives in a `let` in `offscreen/main.ts`, closed and nulled in both `try` and `finally`; the offscreen document ships `connect-src 'self'` in both manifests |
| **Fail closed** | the gate returns `blob: null` and zero bytes; the server independently returns **409** to a client reporting an abort |
| **Destructive actions need a human** | checked in three places: client executor, `server/actions.py`, and the model system prompt |
| **Passwords never pseudonymized** | the schema has no field for one; a test asserts the real value never appears in output |
| **No invented numbers** | the metric runner prints `NOT MEASURED` rather than a placeholder |
| **No silent degradation** | every model load records *why* it failed (`getLoadErrors`), surfaced in the HUD |

---

## Threat model

**What leaves the device:** a pruned accessibility tree with placeholders, a
redacted WebP, and a signed manifest. Never a raw frame, never a real value.

**What an attacker gets:** structure and a redacted image. The worst case is a
false-negative redaction — which is why the gate refuses to emit rather than
emitting optimistically, and why leakage rate is reported as a metric.

**What a malicious page can do:** attempt prompt injection via page text. All
page text is passed as untrusted *data* in the user turn, never as a system
instruction; the system prompt is built from the manifest, not page content;
destructive actions require a human click.

---

## Reproduce

```bash
python bench/gen_synthetic.py        # 20 forms, 248 instances, exact GT
python bench/run_metrics.py          # M1–M5 → bench/results/
python bench/test_server.py          # 17 server fail-closed checks
python bench/verify_models.py        # every model id resolves on the Hub
python bench/make_pr_curves.py       # PR curves + cascade delta
cd extension
npm test                             # 104 unit tests
npx tsc --noEmit                     # clean
npx vite-node bench/measure_l2.ts        # the L2 finding, re-runnable
npx vite-node bench/diagnose_l2.ts       # the raw model output proof
npx vite-node bench/tune_thresholds.ts   # the threshold search
npx vite-node bench/measure_cascade.ts   # the cascade delta
npx vite-node bench/measure_client_cpu.ts
docker compose up                    # server + vLLM
```

Then open `bench/index.html`.

## Model cards

| job | model | size | status |
|---|---|---|---|
| L2 (preferred) | `onnx-community/gliner_multi_pii-v1` | 332 MB | **cannot load in transformers.js** |
| L2 (fallback) | `Xenova/bert-base-NER` | 109 MB | loads; **no PII classes**; disabled by policy |
| L3 detector | `Xenova/detr-resnet-50` | ~43 MB | wired, not measured |
| audit | `HuggingFaceTB/SmolVLM-256M-Instruct` | ~260 MB | optional, disabled on small GPUs |
| T1 planning | Qwen2.5-VL-7B-Instruct | — | server, vLLM V1 |

All Apache-2.0. Fetched at runtime, never bundled — that is what keeps the
extension at 181 kB. `bench/verify_models.py` re-checks every id against the
Hub, because an earlier revision cited two ids that did not exist and would
have failed silently forever.

## Known gaps

- **The neural layer does not function.** Documented above with reproducible
  evidence, and disabled rather than faked.
- **L3 pixel detectors are unmeasured**, so canvas-text and closed-shadow PII
  remain undetected (0/4 and 4/16).
- **M1, M3, M5 are unmeasured.**
- **The Firefox build drops the pixel channel** entirely (no `tabCapture`).
- **Delta-tile upload** is implemented server-side but not exercised end to end.
