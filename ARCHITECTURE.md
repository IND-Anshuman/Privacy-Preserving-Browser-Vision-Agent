# Privacy-Preserving Browser Vision Agent — Implementation Plan & Technical Design

> **This document is binding law.** Where the implementation prompt and this document disagree, this document wins. It is the source of truth for the five published evaluation metrics and every design decision cited below.

A grounded design for the SIH problem statement: *"privacy-preserving vision agent which runs on browser"*, where a local vision model reads the user's screen, sensitive data is redacted **client-side before any network request**, and only anonymized context reaches a central server LLM/VLM that returns actionable commands.

Everything below is written to hit the five published evaluation metrics directly:

| # | Metric | Weight | Which design section is the primary lever |
|---|---|---|---|
| 1 | Accuracy of visual context from screen | 25% | §4 Hybrid perception (DOM + SoM-annotated pixels) |
| 2 | Recall & precision for PII detection | 20% | §5 Cascaded PII detector (4 layers + score fusion) |
| 3 | Precision of redaction | 20% | §6 GPU redaction + fail-closed gate + leakage audit |
| 4 | Client-side resource utilization | 20% | §7 Scheduling, caching, frame-diff gating, tier-0 local path |
| 5 | End-to-end latency | 15% | §8 Three-tier routing, prefetch, streaming, budget table |

> **Product name: Veil.** User-facing copy never exposes internals — only "6 items hidden on this page" and "nothing sensitive left your device".

---

## 1. The one architectural idea that wins this problem

Most teams will build "screenshot → blur → upload". That scores badly on metric 1 (a blurred screenshot has lost the semantics the server needs), badly on metric 3 (they'll blur, not classify), and badly on metric 4 (heavy models on the main thread).

The differentiator is a **two-channel perception model with a privacy gate between them**:

```
 ┌──────────── DOM CHANNEL (structure, zero pixels) ────────────┐
 │ content script: accessibility/DOM snapshot, roles, labels,   │
 │ input semantics, value-type inference, bbox anchors          │
 └───────────────────────────┬──────────────────────────────────┘
                             │
 ┌──────────── PIXEL CHANNEL (what the DOM cannot see) ────────┐
 │ offscreen doc: tab capture → OffscreenCanvas → local CV     │
 │ (faces, text-in-canvas, images/video, screenshots-of-pii)   │
 └───────────────────────────┬──────────────────────────────────┘
                             ▼
              ┌─────────────────────────────┐
              │   FUSION + REDACTION GATE    │  ← single choke point
              │  (typed placeholders, boxes) │     fail-closed
              └──────────────┬──────────────┘
                             ▼  (only sanitized bytes exist downstream)
        Server: open-weights VLM → JSON action plan → client executes
```

Three consequences judges will notice:

1. **Metric 1 without privacy loss.** The server gets *structure* (which is what makes "click the submit button" reliable) and *redacted pixels* (which is what makes "summarize this page" possible). Blur-only approaches throw away the first channel.
2. **Precision by construction.** Because redaction boxes are anchored to real DOM rects and typed by input semantics, precision is high *and* the redaction survives layout shift (recomputed, not painted-once). This is the same hybrid-perception idea industry browser agents converge on: structural/runtime snapshots are far cheaper than raw screenshots, but pixels are still needed for canvas, video, and image content.
3. **Metric 4 is a first-class citizen.** The pixel channel is gated by a frame-difference hash, so a static page costs ~0 inference. A large share of tasks never leave the device at all.

**Naming.** Pick something short and non-jargon for user-facing copy (e.g. *Veil* / *BlindSpot*). The user should never see words like "redaction pipeline" in the product surface — only "6 items hidden on this page" and "nothing sensitive left your device".

---

## 2. Client architecture (MV3 extension, Chrome + Firefox from one codebase)

Use **WXT** (or Plasmo) so a single TypeScript project emits both a Chrome MV3 bundle and a Firefox MV3 bundle — the PS explicitly names both browsers, and hand-maintaining two extensions is where teams lose their weekend.

Four contexts, each with a strict job:

| Context | Job | Why there |
|---|---|---|
| **Background service worker** | Orchestration only: route user intent, sequence capture→redact→send→execute, own the reconnect/offline state machine. Zero heavy compute, zero long-lived state. | MV3 SWs are killed aggressively; nothing precious may live there. |
| **Offscreen document** | The **inference sandbox**: tab capture, `OffscreenCanvas`, WebGPU device, transformers.js v4 / ONNX Runtime Web, redaction compositing, model cache. | MV3 service workers have no DOM and no WebGPU access in practice — running GPU inference there is not an option.[unverified] `chrome.offscreen` exists precisely to give an extension a hidden DOM-capable document, and its documented reasons include `WORKERS`, `DISPLAY_MEDIA` and `BLOBS`, which are exactly the three capabilities this design needs.[2] |
| **Content script** | DOM channel: snapshot, classification, rect anchors, SoM overlay injection, action execution. | Only place with page access. |
| **Side panel / popup** | Chat, redaction preview, per-stage latency waterfall, privacy ledger, benchmark dashboard. | The demo surface. Also where the 1-click "why did you hide that?" trust UI lives. |

**Design decision: a three-mode capture ladder.**
1. **Default — `tabCapture` MediaStream** (live mode): zero per-frame API cost after setup; frames transfer to the offscreen worker as `VideoFrame` by reference (zero-copy structured clone). Required for canvas/video pages. Note that once you hold the stream you must re-route audio to keep the user hearing the tab.[1]
2. **Fallback — `chrome.tabs.captureVisibleTab`** (snapshot mode): simplest, lowest permission friction — but it is **hard-throttled to 2 calls/second** (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2`) and Chrome's own docs call it "expensive."[15] Poll it at ≤1.5 Hz, and only when the frame-diff gate (§7) reports the page changed.
3. **Region Capture API on top of either.** `CropTarget.fromElement(el)` + `track.cropTo(cropTarget)` crops the captured track *at the compositor level* to an element's bounding box — and the crop **follows the element automatically as it moves or resizes**, no re-targeting needed.[17] Crop capture to the page's main content area (toolbars/address-bar pixels are never redaction-relevant): ~20–40% fewer pixels to process *and* to upload.

Say this out loud in the report — the capture ladder plus the 2-calls/sec throttle shows you understand the trade-off instead of having discovered it in the middle of the night.

**Firefox.** Ship the same bundle; the WebGPU reality has improved but not converged: WebGPU shipped on-by-default in Chrome/Edge, and **Firefox 141 (July 2025) enabled WebGPU by default on Windows**[14] — while Firefox on macOS/Linux and Safari still need flags.[3][11] So the **WASM fallback is mandatory, not a nicety** — and the benchmark tables should show three rows (Chrome WebGPU / Firefox WebGPU / WASM) instead of two.

---

## 3. Local model stack — deliberately light

The PS says local, and metric 4 punishes heaviness. So: no OmniParser-class model on the client.[8] Use a **small ensemble of single-purpose models**, each a few MB-to-tens-of-MB, plus one tiny VLM only for the pixels the DOM cannot explain.

### 3.1 Runtime
- **Transformers.js v4** as the primary runtime: it adopted a new WebGPU runtime rewritten in C++ with the ONNX Runtime team, tested across ~200 model architectures, and re-implements exports operation-by-operation using ORT contrib ops (`GroupQueryAttention`, `MatMulNBits`, `QMoE`), reporting ~4× speedup for BERT-based embedding models from the `MultiHeadAttention` operator alone.[4] v3 established WebGPU as "up to 100× faster than WASM" and 1200+ pre-converted Hub models.[3]
- **ONNX Runtime Web with the WebGPU EP** as the escape hatch for anything Transformers.js doesn't cover — the documented usage is literally `import 'onnxruntime-web/webgpu'` plus `executionProviders: ['webgpu']`, with graph capture and IO-binding to keep tensors resident on the GPU and avoid `getData()`/dispose churn.[5]
- **Fallback chain:** WebGPU → WASM (SIMD + threads; needs cross-origin isolation, which an extension page can set on itself) → **Chrome built-in AI** as the no-download tier.[12][13]

### 3.2 Model roster (each earns its place)

| Job | Model choice | Why this one |
|---|---|---|
| Face detection in images/video/webcam regions | a small face detector (BlazeFace-class, q8 ONNX) | Fast, tiny, high recall at low IoU — recall matters more than box beauty here because we over-redact faces anyway. |
| Text-in-image / canvas text regions | a lightweight text detector (DB/EAST-class, q8) | The DOM cannot see `<canvas>`, `<video>`, and images — this is the single highest-value pixel model. |
| PII in DOM text (names, orgs, addresses that regex misses) | a quantized token-classification NER (DeBERTa/RoBERTa-class) | Regex has ~0 recall on PERSON/ORG; this is where metric 2 recall is won. |
| Whole-screen semantic fallback | **SmolVLM-256M / 500M** — HF released these as the smallest VLMs in the family, at 256M and 500M parameters.[6] | Runs the redaction-audit pass ("is anything identifying left in this frame?") locally. Small enough to be *continuous* rather than a one-shot. |
| Optional tier-0 chat | **WebLLM** (`@mlc-ai/web-llm`, WebGPU-accelerated in-browser inference with no server component)[9] or a small model via Transformers.js | Lets a meaningful class of tasks complete with **zero network calls**. |

### 3.3 Free tier-0: Chrome's built-in Prompt API
Chrome's Prompt API runs Gemini Nano inside the browser, supports **image input** (`HTMLCanvasElement`, `ImageBitmap`, `OffscreenCanvas`, `ImageData`, `Blob`, …) via `expectedInputs: [{type:'image'}]`, and is available to extensions from Chrome 138 (web: Chrome 148), with `LanguageModel.availability()` to gate the download state.[12]

Two uses, both valuable:
1. **Redundancy auditor**: when a redaction is borderline, ask Gemini Nano locally "does this region contain an identifier?" — zero network, zero privacy cost.
2. **Ultra-cheap tier-0 answering** for "what's on my screen?" so the demo can show a request that never leaves the machine.

Document the stated hardware gate honestly: strictly more than 4 GB of VRAM for GPU execution, or 16 GB of RAM with 4+ cores for CPU execution, plus at least 22 GB free storage.[12] This is a strength — you can state the *fallback policy* in one line, which is what judges probe.

---

## 4. Metric 1 (25%): hybrid perception + Set-of-Mark grounding

Send **three aligned artifacts** in one request, all redacted:

1. **`screen_state.json`** — a pruned, token-efficient tree built from the accessibility/DOM snapshot:
   `{ id, role, label, valueType, valueClass: "sensitive"|"public"|"masked", bbox, mark, actions:[click,fill,focus,scroll] }`.
   Prune: drop nodes with no accessible name and no interactive role; collapse repeated list rows; cap depth. Target a few hundred tokens for a typical page.
2. **`screen.webp`** — the redacted frame at capped resolution (long edge ~1280, DPR clamped) with **numbered Set-of-Mark badges** burned over interactive elements. Set-of-Mark prompting overlays numbered, speakable spatial marks on an image to unlock visual grounding in multimodal models.[7] This is the cheapest known accuracy-per-token win for "click *that* button".
3. **`redaction_manifest.json`** — the redaction schema the server must respect: `{schema_version, redactions:[{id, box, type, placeholder, method}], frame_hash, model_versions}`.

**Why this scores.** The server never has to guess *where* — it picks `{"action":"click","target":{"mark":17}}`. And because marks are re-derived every cycle and resolved to nodes at execution time, the plan survives DOM re-renders (a stale-node-reference failure that sinks most browser-agent demos).

**Action vocabulary** (constrained JSON, streamed): `click`, `fill`, `focus`, `select`, `scroll`, `hover`, `navigate`, `extract`, `wait_for`, `ask_user`, `none`. Anything destructive (`submit`, `send`, `pay`, `delete`) requires a **client-side confirmation toast** — a privacy feature the judges will notice on their own.

---

## 5. Metric 2 (20%): four-layer PII cascade with score fusion

Detection is a **union of cheap-and-precise with expensive-and-recall**, then a per-class threshold sweep on your own labeled set.

```
 L0  TYPE/SEMANTICS      input[type=password], autocomplete tokens, role, aria-label, name,
                         data-* patterns, contenteditable, hidden-but-visible      cost ~0 ms
 L1  REGEX + CHECKSUM    email, phone (IN-aware), card (Luhn), Aadhaar (Verhoeff-ish/digit),
                         IFSC, PAN, GSTIN, IBAN, passport, JWT/API key, DOB, IP,
                         bank acct, UUID-as-user-id                                cost ~1 ms
 L2  NER (WebGPU)        GLiNER-PII zero-shot span detector (preferred) or a quantized
                         token-classification DeBERTa/RoBERTa fallback → PERSON / ORG /
                         LOC / DATE / ADDRESS / MONEY                              cost ~15–40 ms
                         per batch
 L3  PIXELS              face detector + text detector over canvas/video/image regions,
                         then OCR-lite to recover strings, then re-run L1/L2 on them  cost ~30–80 ms
```

**L2 model choice.** Prefer **GLiNER** (`urchade/gliner_multi_pii-v1`, Apache-2.0, trained on synthetic PII data, EN+FR+DE+ES+PT+IT) — a zero-shot span detector built for exactly these classes (PERSON/EMAIL/PHONE/ADDRESS/CARD) with no fine-tuning, and community ONNX conversions for browser use.[20] It has higher recall on PII classes than a general NER, and regex (L1) absorbs the easy ~80% at ~1 ms/page so GLiNER only sees ambiguous text. Keep the DeBERTa-class model as the documented fallback.

**Fusion.** Each hit is `(class, source, score, rect, span)`. Union with per-class thresholds `τ_class` chosen to maximize F1 on your labeled set — *not* one global threshold, because a face miss and a phone-number false positive have very different costs. Track precision/recall per class and report the macro and micro numbers.

**Calibration set is a deliverable.** Build 50–80 screens: 20 synthetic forms with known injected PII (so GT is exact), 20 real-world pages, 20 adversarial cases (PII inside images, inside `<canvas>`, inside SVG `<text>`, split across a shadow root, inside a cross-origin iframe, autofilled password, PII in a `data-*` attribute). This is 40% of the rubric and most teams will wing it. Don't.

**Hard cases to handle explicitly:**
- **Passwords:** never send, never even hash into a stable pseudonym (hash of a password is an attack surface). Emit `type:"password", value:"<redacted:password>"`.
- **Shadow DOM / closed roots:** walk open shadow roots; for closed ones fall back to **geometric** redaction from L3 detectors. Say so in the report.
- **Cross-origin iframes:** the content script gets `all_frames: true`; a frame that refuses injection is treated as **fully sensitive** (fail-closed) and redacted wholesale.
- **Autofill / password managers:** inputs can be populated without input events — re-scan value attributes on every cycle, don't rely on `input` listeners.
- **Text drawn in canvas or rendered in a video frame:** invisible to every DOM rule; L3 is the only defence. This is why L3 exists and why the write-up should say so.

Reference implementation for the server-side twin of this problem (detecting, redacting and anonymizing PII across text, images and structured data) is Microsoft's Presidio — use it to sanity-check your class taxonomy and your server-side fallback, not as a client dependency.[10]

---

## 6. Metric 3 (20%): redaction that is verifiable, not decorative

### 6.1 Three redaction *methods*, chosen per item
| Method | Use for | Preserves utility? |
|---|---|---|
| **Solid fill** (rounded rect, class-tinted) | passwords, card numbers, Aadhaar/PAN, ID docs | No — value is gone, which is the point |
| **Pixelation** (GPU, block size scaled to box) | faces, ID photos, signatures | Yes — layout and "there is a photo here" survive |
| **Typed placeholder substitution** | names, emails, phones, addresses in *text* | **Yes** — see below |

**Typed placeholder substitution is the trick that lifts both metric 1 and metric 3.** Instead of deleting a value, replace it with a stable, typed token:

```
"Ankit Sharma (9876543210, ankit@acme.in) owes ₹42,000"
  →  "[PERSON_1] (contact: [PHONE_1], email: [EMAIL_1]) owes ₹42,000"
```

The server still understands *structure, relationships, and field semantics* — it can answer "what does this form need?" and "how many fields are prefilled?" without ever seeing a value. Consistent pseudonymization (same entity → same token within a session, via a per-session salted hash kept **only in the client**) preserves co-reference so multi-field reasoning still works. This is what "semantic obfuscation" in the PS actually buys you, and it is the difference between a redacted screenshot and a *usable* redacted screenshot.

### 6.2 Compositing on the GPU — zero-copy, no readbacks
Keep the capture as a `VideoFrame`/GPU texture and do redaction in a **WebGPU render pass on the same `OffscreenCanvas`** that holds the capture: rounded-rect fill, pixelation pass, or separable Gaussian blur for faces (radius ∝ face box size). The ONNX Runtime Web guidance on IO binding — keep tensors resident on the GPU and avoid `getData()`/dispose churn[5] — applies equally to the pixel pipeline: **every GPU→CPU→GPU bounce is 5–15 ms donated per frame**, so the frame must stay on the GPU from capture → redact → encode (`convertToBlob`) without a CPU readback.[unverified — the comparative figure is our target, not a published benchmark] Pixelation beats blur for faces on both axes: one downsample+upsample pass (cheaper than separable-kernel blur) and no "deblur" ambiguity.

### 6.3 The fail-closed gate (write this as a first-class component)
```
raw frame ──► [in-memory only] ──► classification ──► redaction pass ──► gate ──► POST
                 │                                        │              │
                 └─ zeroed/overwritten, dropped           └─ boxes ──────┘
                                                                   │
                              gate asserts: every GT-class item covered,
                              no unmasked high-score region, schema
                              matches, frame_hash matches  → else ABORT (no request)
```
- The raw frame **never** crosses a function boundary that can reach `fetch`/`XMLHttpRequest`/`sendBeacon`/WebRTC. Enforce with a strict CSP on the offscreen document (`connect-src` limited to the agent origin) and by keeping the raw buffer in a closure that is nulled after compositing.
- The client signs/hashes the redaction manifest and sends it with the request, so **the server is verifiably aware of the redaction scheme** — directly satisfying the PS wording, and it doubles as a tamper-evidence story.
- The side panel shows a **privacy ledger**: every outbound request, byte count, redaction count, and a side-by-side "what the server saw" thumbnail. This is the single highest-ROI demo artifact; judges can verify the claim themselves in ten seconds.
- The side panel is the agent's **entire** user interface: ask, watch, approve. Three tabs — Agent (conversation, step list, approval gate), Privacy (what was hidden, what the assistant received, byte count), Timeline (per-stage timing and waterfall).
- **The approval gate is the load-bearing part of that UI.** §4 requires a destructive step to become `ask_user`, and the client halts and waits for `content:confirm`. The service worker and content script both handle that message; if no UI can *send* it, a destructive action halts forever with no way forward, and a safety mechanism that is unreachable is worse than none because it looks handled. Declining must be as prominent as approving — a refusal path that is harder to reach than consent is a refusal nobody uses.

### 6.4 Leakage audit (report it as a metric — nobody does this)
Redaction precision measured only as "did you draw boxes" is gameable. Report instead:
- **Box IoU** vs ground truth.
- **Recoverability rate**: run OCR (or the local VLM) on the *redacted output* and check whether any GT PII string is still recoverable → this is the honest "precision of redaction" number.
- **Leakage rate** = recovered PII instances / total GT PII instances. Target 0.00 on the calibration set; report the handful of adversarial failures openly.

---

## 7. Metric 4 (20%): resource discipline

Budgets to state in the report (these are *design targets*, stated as such):

| Resource | Target | Mechanism |
|---|---|---|
| Peak JS heap | < 200 MB | models in Cache Storage / GPU, never in JS heap; reuse one `InferenceSession` per model |
| Model bytes downloaded | once, ever | Cache Storage + `transformers.js` Hub cache; version-pinned URLs |
| Idle CPU | ~0% | no timers when no task is pending; inference on demand only |
| Per-cycle client compute | < 250 ms | frame-diff gate + L0/L1 short-circuit |
| Network | 0 requests for tier-0 | local answering path |

The single biggest win is the **frame-difference gate**:
1. Downscale the capture to a 64×64 luma thumbnail on the GPU.
2. Compare against the previous thumbnail (mean abs diff / dHash).
3. If Δ < threshold **and** the DOM hash (structural fingerprint of the pruned snapshot) is unchanged → skip the entire pipeline. Static page: ~0 cost.
4. Reuse the previous redaction boxes for unchanged regions; re-run detection only on dirty tiles.

Secondary levers: run L2/L3 in a dedicated `Worker` inside the offscreen document; cap resolution before upload (bandwidth *and* server cost); batch text through the NER model per frame rather than per node; cache model *sessions* forever (session creation dominates cold latency); prefer `q8`/`int4` weights; and expose a **live resource HUD** (heap from `performance.measureUserAgentSpecificMemory()` where available, GPU adapter limits, per-model timings) — judges love watching the number stay flat.

**Adaptive cascade via the Compute Pressure API.** `PressureObserver` reports system CPU pressure (`nominal` / `fair` / `serious` / `critical`) and works in window, dedicated-worker, and shared-worker contexts[16] — wire it into the scheduler:

```
critical → skip L2/L3 this frame; L0/L1 regex-only redaction (fail-safe, still private)
serious  → L2 only; defer the SmolVLM audit pass
nominal  → full cascade
```

This is metric-4 gold: the extension *visibly* degrades its own footprint when the machine is loaded, and the HUD can show the throttle decisions live. It is also the direct answer to "what happens on a weak laptop?" — you do not just survive it, you manage it.

**Delta-tile upload on multi-step tasks.** The frame-diff gate already computes tile-level change; on turns 2..N of a task, send only changed tiles plus coordinates and let the server re-composite. On a 5-step form-filling task this cuts total upload by 60–80% — a number that belongs on a slide.

---

## 8. Metric 5 (15%): three-tier routing + prefetch

| Tier | Path | When | Network |
|---|---|---|---|
| **T0** | DOM snapshot + local model (Prompt API / WebLLM / SmolVLM) | known intents: "what's on screen", "summarize", "find the error", PII re-audit | none |
| **T1** | redacted context → self-hosted open-weights VLM (vLLM / TensorRT-LLM) during SIH; cloud-hosted twin of the same weights otherwise | open-ended reasoning, planning, grounding | yes |
| **T2** | escalation (heavier VLM) | only when T1 returns low confidence or `none` | yes, rare |

Latency work, in order of payoff:
1. **Prefetch the sanitized frame.** The moment the page settles (MutationObserver + `requestIdleCallback` + a 400 ms quiet window), capture → redact → park the payload in memory. When the user hits Enter, the request starts with T=0 already paid. This typically removes the entire client half of the latency from the critical path.
2. **Server engine: vLLM V1 + prefix caching + XGrammar + n-gram speculation** — see §9. This stack is the difference between a 700 ms and a ~350 ms server turn on small plans, and it is mostly configuration, not code.
3. **Streaming + partial execution.** Stream the plan as SSE (not WebSocket — one fewer handshake, proxies cleanly) and, because XGrammar guarantees schema-valid prefixes, **execute each action object the moment its closing brace arrives** — a complete `{"action":"click","target":{"mark":17}}` fires while the rest of the plan is still generating. First-action latency drops from full-plan latency to first-object latency, typically 40–60% of the total.
4. **Warm server**: keep the vLLM server resident with prefix caching on the static system prompt; the redaction-schema preamble is identical every turn.
5. **HTTP/2 or HTTP/3, single round trip**, image as WebP quality ~80 at capped resolution (long edge 1280, DPR clamp) via `canvas.convertToBlob`; offer AVIF (`convertToBlob({type:'image/avif'})`) as a weak-network mode — smaller but slower to encode, so not the default.
6. **Smallest sufficient VLM.** SmolVLM-256M/500M exist precisely because small VLMs got good;[6] pick the smallest model that holds accuracy on your own eval, and report the accuracy-vs-size curve.

Target waterfall (design targets, to be measured and reported honestly):

```
capture 15ms │ redact 40ms │ upload 60ms │ T1 TTFT 350ms │ stream 200ms │ execute 30ms  ≈ 700ms p50
                       (first action visible at ~450ms with partial execution)
```

Report **p50 and p95**, with a per-stage breakdown rendered in the side panel. A published p95 with an honest failure note beats a claimed average every time.

---

## 9. Server design (deliberately thin)

The PS permits open-source/open-weights models, cloud-hosted during SIH, offline-deployable after. Keep the server boring so the effort lands on the client, where the marks are.

- **FastAPI** (or a single Node/Hono service if you prefer one language) + **vLLM V1** serving an open-weights VLM. V1 delivers up to **1.7× higher throughput than V0** from CPU-overhead reductions, with *even larger* gains on VLMs (benchmarked on Qwen2-VL) from offloading multimodal input preprocessing to a separate process — plus prefix caching now native for multimodal models.[19] Your redaction-schema preamble is identical every request, so prefix caching is free money.
- **Constrained decoding via XGrammar**, the structured-generation engine integrated into vLLM, SGLang, MLC-LLM, and TensorRT-LLM with **near-zero overhead in JSON generation**.[18] The action-plan schema is enforced at the token level — no parse-failure retries (pure latency), no invalid-action fallback path (a robustness risk).
- **N-gram / prompt-lookup speculative decoding**: the action vocabulary is tiny and plans are repetitive (`click`→`wait_for`→`fill`), so drafted tokens are nearly free — expect 1.3–2× on structured, low-entropy output.[unverified — well-established technique; treat as a measure-it target]
- **Delta-tile re-compositing**: the server accepts changed-tiles-only payloads on turns 2..N of a task and re-composites against the last full frame (§7).
- **Redaction-aware prompting**: the manifest is injected as a system preamble — "boxes listed as `type: PERSON` were masked client-side; `[PERSON_1]` tokens are stable pseudonyms; never ask for or infer their real values; if a task requires a masked value, emit `ask_user`."
- **A `needs_more_context` / `none` escape** so the model degrades honestly instead of hallucinating a target.
- **Stateless + no logging of payloads** (log hashes and byte counts only) — consistent with the privacy claim, and say so.
- **Self-hosted path documented**: one `docker compose up` (vLLM + model weights) reproduces the SIH cloud behaviour offline. State the exact weights and versions.

---

## 10. Evaluation harness (build this in week 1, not last)

The part that separates a top-5 finish from a mid-table one, because it maps 1:1 onto the rubric.

| Metric | How you measure it | Artifact |
|---|---|---|
| 1. Visual context accuracy | 40-task suite; success = correct element reached; also report top-1 mark accuracy and a ScreenSpot-style grounding score | results table + per-task traces |
| 2. PII recall/precision | per-class PR on the 50–80 screen calibration set; micro + macro F1; report the L0/L1-only vs full-cascade delta (shows the cascade earns its cost) | PR curves |
| 3. Redaction precision | box IoU + **recoverability-based leakage rate** (§6.4) | leakage table with the failures named |
| 4. Client resources | peak heap, per-cycle ms, bytes downloaded, idle CPU, over the 40-task suite; include a **weak-device** row (WebGPU disabled → WASM path) | resource table + the live HUD |
| 5. E2E latency | p50/p95 end-to-end plus per-stage; tier-0 vs tier-1 split | waterfall chart |

Ship a **self-contained benchmark page** in the repo so a judge can run the whole thing in one click. Reproducibility is a scoring multiplier nobody remembers to award but everybody rewards.

---

## 11. Demo script (60 seconds, three scenes)

1. **The leak that isn't.** A banking/insurance form with a password field, an Aadhaar number, a face photo in an `<img>`, and PII drawn inside a `<canvas>`. Press the action key. Watch the side panel: *6 items hidden · 0 raw bytes sent*. Then open DevTools → Network and show the request body contains only `[AADHAAR_1]`, `[PERSON_1]`, and a redacted WebP.
2. **It still works.** Same page: *"fill the non-sensitive fields and click Submit."* T1 returns a mark-anchored action plan; the client fills and — because `submit` is in the destructive set — asks for one confirmation click. Task completes with the sensitive fields untouched.
3. **Zero requests.** *"What's on my screen?"* answered entirely by T0. Network tab stays empty. Privacy ledger shows `0 requests`.

Then a hard-mode appendix: iframe that blocks injection (fail-closed redaction), PII inside a video frame, and a static page where the frame-diff gate drops client compute to ~0 ms.

---

## 12. Build plan (36-hour shape, 4 people)

| Phase | Hours | Deliverable | Owner |
|---|---|---|---|
| **P0 Skeleton** | 0–6 | WXT extension (Chrome+Firefox), SW ↔ offscreen ↔ content wiring, capture ladder (tabCapture MediaStream / captureVisibleTab fallback / Region Capture crop) → `OffscreenCanvas` round trip, side panel shell | all |
| **P1 Perception** | 6–14 | DOM snapshot + pruning + hashes, SoM overlay, frame-diff gate, resources HUD | 2 |
| **P2 Privacy** | 14–22 | L0/L1 cascade, GLiNER-PII on WebGPU, pixel detectors, fusion + thresholds, GPU zero-copy redaction, fail-closed gate, privacy ledger, Compute Pressure adaptive cascade | 2 |
| **P3 Server** | 18–26 | FastAPI + vLLM V1 (prefix cache, XGrammar, n-gram speculation), redaction-aware prompt, delta-tile re-compositing, SSE streaming, action executor + confirmations + partial execution | 1 |
| **P4 Bench** | 20–30 | Calibration set, all five metric scripts, results tables/plots, benchmark page, three-browser rows (Chrome WebGPU / Firefox WebGPU / WASM) | 1 |
| **P5 Polish** | 26–34 | Demo scenes, fallback matrix (no-WebGPU / no-Prompt-API), README, Dockerfile, video | all |
| **Buffer** | 34–36 | Judging-rehearsal fixes only | all |

**Critical path:** P2. The privacy cascade is where 40% of the marks live and the only part that can silently fail. Staff it first and deepest.

**Risks & pre-computed fallbacks** (decide these *now*, don't discover them at hour 30):

| Risk | Fallback (already decided) |
|---|---|
| WebGPU unavailable / unstable | WASM SIMD+threads path via ORT Web; report both rows in the benchmark |
| captureVisibleTab throttle (2 calls/sec)[15] | tabCapture stream is the default; snapshot mode polls ≤1.5 Hz behind the frame-diff gate |
| Chrome Prompt API unavailable (hardware gate, download pending)[12] | SmolVLM-256M local + WebLLM; feature-detect and hide the UI affordance |
| Machine under load mid-task | Compute Pressure API downshifts the cascade (§7) instead of stalling |
| NER model too slow on weak GPUs | L0/L1 only + higher-tier escalation; show the latency/recall curve |
| `<canvas>`/`<video>` PII defeats DOM rules | fail-closed: any canvas/video region with detected text or a face is **wholly** redacted unless explicitly cleared by the user |
| Content script blocked on a page | pixel-only tier: redacted frame + SoM, no DOM channel; visibly degraded but still works |
| Server VLM returns a bad target | schema validation + mark re-resolution; on failure → `ask_user`, never a blind click |
| Two people want the same file | ownership table above, contract-first: agree the JSON schemas (§4, §6.1) in hour 1 and code against them |

---

## 13. Reporting checklist (what the write-up must contain)

1. **Threat model**: what leaves the device (nothing raw, ever), what an attacker gets (a redacted frame + structure), and what a malicious *page* could do to the agent (prompt-injection via page text → mitigated by treating all page text as untrusted data, never as instructions, plus confirmation on destructive actions). Stating the injection risk yourself is a strong signal.
2. **Capability-detection matrix** with graceful degradation, per browser.
3. **The five metric tables from §10**, with failure cases named.
4. **Model cards**: exact weights, licences, sizes, quantization, and where each runs.
5. **Cost**: measured tokens/second and ₹/task, with the tier-0 share reported as the headline privacy-plus-cost win.
6. **Offline story**: `docker compose up` for the server; extension works fully offline in tier-0.

---

Sources:
[1] https://developer.chrome.com/docs/extensions/reference/api/tabCapture — chrome.tabCapture
[2] https://developer.chrome.com/docs/extensions/reference/api/offscreen — chrome.offscreen
[3] https://huggingface.co/blog/transformersjs-v3 — Transformers.js v3 (WebGPU)
[4] https://huggingface.co/blog/transformersjs-v4 — Transformers.js v4
[5] https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html — ONNX Runtime Web WebGPU EP
[6] https://huggingface.co/blog/smolervlm — SmolVLM 256M/500M
[7] https://github.com/microsoft/SoM — Set-of-Mark prompting
[8] https://github.com/microsoft/omniparser — OmniParser
[9] https://github.com/mlc-ai/web-llm — WebLLM
[10] https://microsoft.github.io/presidio — Microsoft Presidio
[11] https://caniuse.com/webgpu — caniuse WebGPU support
[12] https://developer.chrome.com/docs/ai/prompt-api — Chrome Prompt API (built-in AI)
[13] https://developer.mozilla.org/docs/Web/API/WebGPU_API — MDN WebGPU API
[14] https://www.mozilla.org/en-US/firefox/141.0/releasenotes/ — Firefox 141 release notes (WebGPU on Windows)
[15] https://developer.chrome.com/docs/extensions/reference/api/tabs — chrome.tabs (captureVisibleTab limits)
[16] https://developer.chrome.com/docs/web-platform/compute-pressure — Compute Pressure API
[17] https://developer.chrome.com/docs/web-platform/region-capture — Region Capture API
[18] https://github.com/mlc-ai/xgrammar — XGrammar structured generation
[19] https://blog.vllm.ai/2025/01/27/v1-alpha-release.html — vLLM V1 alpha
[20] https://huggingface.co/urchade/gliner_multi_pii-v1 — GLiNER multi PII v1
