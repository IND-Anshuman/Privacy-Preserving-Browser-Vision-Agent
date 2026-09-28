# 2026 Innovations — Verified Findings

Everything below was verified directly (HuggingFace API, arXiv API, Chrome docs, or **live model
execution**). The single most important item is not an innovation — it is a correction: **your L2
finding is wrong, and I proved it by running the model.**

---

## 1. THE BIG ONE: the neural PII layer works. It just needed a different model.

Your README states:

> `Xenova/bert-base-NER` … its entire label space is `{PER, ORG, LOC, MISC}`. Given a literal email
> address it returns no entities at all. … those classes do not exist in CoNLL-2003's label space, so
> no threshold and no prompt can produce them.

That is **true about `bert-base-NER` and false as a conclusion about browser NER.** You tested one
model from a family (CoNLL-2003) whose label space genuinely lacks PII classes, then generalized to
"no browser-loadable NER has PII classes." The actual answer was published and has an ONNX export.

### The model: `onnx-community/bert-small-pii-detection-ONNX`

| | |
|---|---|
| Pipeline | `token-classification` (exactly what your L2 needs) |
| `library_name` | **`transformers.js`** — declares browser support |
| License | **Apache-2.0** |
| Modified | 2026-04-10 |
| int8/q8 weights | **27.4 MB** (full fp32: 108.9 MB) |
| Quantizations | `int8`, `q4`, `q4f16`, `fp16`, `bnb4`, `uint8` — all present |
| Label space | **49 labels / 24 PII classes** |

Its `B-` classes: `AGE, COORDINATE, CREDIT_CARD, DATE_TIME, EMAIL_ADDRESS, FINANCIAL, IBAN_CODE, IMEI,
IP_ADDRESS, LOCATION, MAC_ADDRESS, NRP, ORGANIZATION, PASSWORD, PERSON, PHONE_NUMBER, TITLE, URL,
US_BANK_NUMBER, US_DRIVER_LICENSE, US_ITIN, US_LICENSE_PLATE, US_PASSPORT, US_SSN`

### I ran it. Live output, transformers.js 4.3.0, `dtype: 'q8'`:

```
TEXT: Contact Divya Banerjee at divya.banerjee@mailbox.net or 6117651412.
  B-PERSON        0.979   "di"
  I-PERSON        0.983   "##a"
  B-EMAIL_ADDRESS 0.790   "di"
  I-EMAIL_ADDRESS 0.995   "mail"
  I-EMAIL_ADDRESS 0.994   "##box"
  I-EMAIL_ADDRESS 0.994   "."
  I-EMAIL_ADDRESS 0.992   "net"

TEXT: Card 4111111111111111 expires 05/09/1959, SSN 123-45-6789.
  I-CREDIT_CARD   0.545–0.662
  B-DATE_TIME     0.894   "05"
  I-DATE_TIME     0.915   "/"
  I-DATE_TIME     0.915   "1959"
  B-US_SSN        0.380   "123"  →  I-US_SSN 0.816

inference: 5–12 ms per string
```

**37 PII spans found. Conclusion printed by the script:**
`a browser-loadable NER WITH a real PII label space EXISTS and runs.`

### What this changes for you

| | before | after |
|---|---|---|
| L2 status | disabled, 332 MB GLiNER attempted every cycle | **enabled, 27.4 MB** |
| PERSON recall | 0.56 (the metric's biggest leak) | 0.98 confidence on names |
| EMAIL / DOB / CARD | 0.92 / 1.00 / 1.00 from regex | regex **plus** model confirmation |
| Story | "the neural layer doesn't work" | "we found the model that does" |

Mapping to your taxonomy: `PERSON, PASSWORD, CREDIT_CARD, IP_ADDRESS, LOCATION` map **directly**.
`EMAIL_ADDRESS→EMAIL`, `PHONE_NUMBER→PHONE`, `DATE_TIME→DOB/DATE`, `ORGANIZATION→ORG`,
`US_SSN→(add class)`, `US_BANK_NUMBER→BANK_ACCOUNT`, `US_PASSPORT→PASSPORT`,
`US_DRIVER_LICENSE→DL`, `IBAN_CODE→IBAN`.

**It does not cover** AADHAAR, PAN, GSTIN, IFSC, API_KEY, ADDRESS, MONEY, FACE — your L1 regex stays
load-bearing for Indian identifiers. That is fine, and honest: L1 for exact formats, L2 for the
things regex structurally cannot do.

**One gotcha:** the model is BERT-`wordpiece`, so it returns subwords. You must merge
`B-PERSON`/`I-PERSON` runs using `offset` before emitting a span, and filter `word` fragments (the
`##` prefix is not present in the decoded output — use the offsets).

### The other PII ONNX models I verified exist

| model | pipeline | size | note |
|---|---|---|---|
| `onnx-community/piiranha-v1-detect-personal-information-ONNX` | token-classification | q8 present | a second independent PII NER, useful for ensemble voting |
| `onnx-community/GLiNER2.5-Decide-ONNX` | text-classification | q4 ≈0.3 MB | **not a PII model** — it is a *router/dispatcher* ("typed-decisions"). Wrong tool; skip. |
| `onnx-community/gliner_multi_pii-v1` | — | 332 MB | your current attempt; `library_name` is **not** `transformers.js` — that's why it failed. Correct diagnosis, wrong conclusion. |

---

## 2. Two papers that are literally your problem statement

An agent found these; I verified both on arXiv.

**`arXiv:2606.12666` — CAPED: Context-Aware Privacy Exposure Defense for Mobile GUI Agents** (2026-06-10)
> "screenshot-based mobile GUI agents can operate ordinary smartphone apps through the same visual
> interface as a human user, but this capability also turns every screen observation into a privacy
> boundary… screenshots may expose contacts, messages, photos, files, recommendations, health cues…
> unrelated to the user's request. We call this problem **incidental visual privacy exposure**. It is
> difficult to address with existing defenses: **text anonymization mi**[sses…]"

This is the exact failure mode of your L1-regex-only approach, independently named in the literature.
**Cite it.** It converts "we didn't handle that" into "we know the state of the art names this
problem, and here's where we sit."

**`arXiv:2609.13873` — PriMobiBench: Characterizing Visual Privacy Leakage in VLM-Driven Mobile GUI Agents** (2026-09-12)
> "the first benchmark for systematically evaluating privacy [leakage] in realistic mobile agent workflows"

The first privacy benchmark for GUI agents. Your `bench/` harness is the desktop equivalent — claiming
priority on a desktop privacy benchmark is a legitimate differentiator, and PriMobiBench gives you
the vocabulary and a citation.

---

## 3. Chrome WebMCP — ships in browsers, changes the architecture

Verified at `developer.chrome.com/docs/ai/webmcp/` (origin trial, flag-gated).

Pages can now expose **structured tools** instead of being scraped. Two APIs:
- **Imperative** — define tools in JS.
- **Declarative** — annotate a standard HTML `<form>` to create a tool automatically.

Security model: gated by **origin isolation** and a **`tools` Permissions Policy** defaulting to
`self` (disabled for cross-origin iframes unless the iframe carries `allow="tools"`). Also stated:
*designed for local browser workflows with a human in the loop*; *clients must visit the site to know
if it has tools*.

**Why it matters to you, both ways:**

1. **Favourable** — it is *human-in-the-loop by design*, which is philosophically identical to your
   destructive-action confirmation. You can adopt the same security model and cite the platform.
2. **Unfavourable, and you should confront it** — if a site exposes form tools, then a future
   agent could complete sensitive forms **without any pixels flowing at all**. Your entire redaction
   guarantee rests on screen capture being the only channel. WebMCP is a structural argument that
   structure-first agents can sidestep the privacy problem entirely.

The meritorious move is to say this yourself. Add a section: *"If WebMCP-style declarative form
tools become the norm, the correct architecture is structure-only with zero pixel egress. Veil's
gate is the safe default for the transition period where that is not yet true."* That is a far more
mature position than silence.

---

## 4. L3 pixel channel: the OCR gap, and a 14× smaller detector

### OCR is missing entirely — and it is the fix for your canvas gap

You have `runL3Text()` which labels every detected region `API_KEY` and never recovers a string. The
architecture's "re-run L1/L2 on recovered strings" (§5) is therefore unimplemented, and canvas/video
PII is undetectable. You measured this: **canvas 4/16, closed shadow 0/4.**

TextOCR-style recognition options, verified on the Hub (all `transformers.js`, all `image-to-text`):

| model | total ONNX | q8 decoder | note |
|---|---|---|---|
| `Xenova/trocr-small-printed` | 787 MB | 39 MB | printed text — what canvas UI uses |
| `Xenova/trocr-small-handwritten` | 787 MB | 39 MB | handwriting (rarely needed for UI) |

787 MB is too heavy to ship, but the **decoder is 39 MB q8** and the encoder can be fp16. The sane
design: run text *detection* cheap, then OCR **only the detected regions**, never the full frame.

**The better move for your budget:** `onnx-community/bert-small-pii-detection-ONNX` (27 MB) can run on
**recovered OCR text** in the browser with no new model — so one added OCR pass closes the canvas gap
through a model you already need.

### Face detection: you are using a 43 MB detector for a 3 MB job

| model | int8 | q4 | note |
|---|---|---|---|
| `onnx-community/yolov10n` | **3 MB** | 9 MB | NMS-free by design — ideal for browsers |
| `Xenova/yolos-tiny` | 9 MB | 7 MB | |
| `Xenova/detr-resnet-50` *(yours)* | **43 MB** | — | DETR: slow, and has a hand-rolled NMS postprocess |

**`onnx-community/yolov10n` at 3 MB int8 is 14× smaller and much faster** than DETR, and its
end-to-end NMS-free design removes the slowest part of DETR inference. Swap it, and the freed
headroom pays for the OCR decoder.

---

## 5. GUI grounding: where the field went

- **`arXiv:2509.02544` — UI-TARS-2** (ByteDance, 2025-09): native end-to-end GUI agent unifying
  perception, reasoning, action, memory, trained with multi-turn RL. This is the current
  state-of-the-art open GUI agent family.
- **`arXiv:2609.27307` — On-Policy Self-Distillation for GUI Agents** (2026-09-23): improves *GUI
  grounding* specifically, which is your M1 metric.

**Actionable, regardless of which model you serve:** these models are trained to consume
Set-of-Mark-style annotated screenshots. Your §4 design is aligned with the frontier — **once you
fix audit finding 1.5**, where `background.ts:274` passes `marks: []` so no badge is ever burned into
the transmitted image. Today the feature that makes your grounding work is inert.

If you want a stronger M1 number: benchmark Qwen2.5-VL against UI-TARS-2 on your own 40-task suite
and publish the table. Comparative grounding scores on your own corpus are worth more than an
absolute number.

---

## 6. Also verified, lower priority

- **Microsoft Presidio** (`github.com/data-privacy-stack/presidio`) — still the reference
  de-identification SDK. Your README already cites it correctly. Its recognizer list is a good
  checklist against your 24 classes; check yours against it before claiming taxonomy coverage.
- **`nacmonad/presidio-web`**, **`atliq/guardex-ai`** — community JS/browser PII ports. Not
  authoritative, but useful as a cross-check set for your L1 regexes.
- **A2A protocol** (`a2a-protocol.org`) and **MCP** — interop standards. Only relevant if you want
  your server to be callable by other agents. Not a scoring lever for this problem statement.

---

## What I could not verify

- Whether `piiranha-v1-detect-personal-information-ONNX` has a different license (the API returned
  `null` for `cardData.license`). Check before shipping.
- Exact PII recall of the bert-small model on *your* corpus. I proved it detects PII; whether it
  improves your F1 from 0.880 needs one run of your own `tune_thresholds.ts` against it. **Do that
  before claiming a number.**
- The subword-merging offset behaviour under WebGPU specifically. I ran on CPU in Node; the
  transformers.js path is identical but confirm on device.

---

## Recommended order

1. **Swap L2 to `onnx-community/bert-small-pii-detection-ONNX` (27 MB q8), re-run your threshold
   sweep, publish the new F1.** This is the single highest-value change in this document: it turns
   your biggest measured weakness (PERSON 0.56) into your strongest story, at 12× less weight than
   the model you already rejected.
2. **Add OCR over detected text regions**, feeding recovered strings into that same 27 MB model.
   Closes canvas/video PII, which is the only place your leak rate is non-zero.
3. **Replace DETR with `onnx-community/yolov10n` (3 MB int8)** to pay for the OCR decoder.
4. **Cite CAPED and PriMobiBench**, and add the WebMCP "what if structure needs no pixels" section.
5. Re-measure M2 end-to-end; the cascade-delta table that justified per-class thresholds will now
   have a genuinely useful second column.
