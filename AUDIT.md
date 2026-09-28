# Veil — Critical Audit

Independent review of the implemented project against the problem statement. Every finding below was
verified by reading the code and, where marked **[verified by execution]**, by running it.

Verdict up front: the architecture and the honesty about its own limits are genuinely good. But the
code is **not in a state where the core promise holds**, and three of the defects are privacy-critical
rather than cosmetic. This is a "fix before demo" list, not a "polish" list.

---

## Severity 0 — the T1 path cannot run at all

### 0.1 `frame_hash: 'pending'` fails schema validation on every run **[verified by execution]**

`content.ts:487` calls `buildSnapshot(msg.runId, 'pending')` — a literal string placeholder. The schema
requires `/^[0-9a-f]{16,64}$/`:

```
FIRST ERROR: Invalid at path frame_hash
```

`background.ts:265` then calls `ScreenStateSchema.parse(...)`, which throws. Every T1 run dies in
`onSnapshotReady` before a frame is ever captured. The 104 passing tests do not catch it because
`schema.test.ts` uses a valid hex hash, and no test exercises the content→background message path.

This alone means the end-to-end demo does not currently function.

**Fix:** compute a real hash in the content script and pass it, or relax to `.or(z.literal('pending'))`
during the snapshot stage and overwrite it in the manifest.

### 0.2 The action plan is never executed

`callServer` parses the plan and sends it to the side panel (`panel:plan`). Nothing iterates
`plan.steps` and pushes them to the content script. `executeStep` exists and is wired to an incoming
`content:execute` message — but no code path ever sends that message with a plan step. The agent
*observes*; it does not *act*.

**Fix:** loop `plan.steps` → `toContent(tabId, {kind:'content:execute', action: step})` →
await `execute:done` → next step, honouring `needsConfirm` and `wait_for`.

---

## Severity 1 — privacy-critical

### 1.1 The DOM channel ships raw PII text to the server

This is the most serious finding. `accessibleName()` returns `el.textContent` for any text-bearing
element, and `buildSnapshot` assigns that straight to `label`:

```ts
label: name          // = textContent, unredacted
valueClass: sensitive ? 'sensitive' : 'masked'   // a FLAG, not a substitution
```

`valueClass: 'sensitive'` is metadata *about* the value. The actual string — `"Divya Banerjee"`,
`"divya.banerjee@mailbox.net"` — is still in `screen_state.json`, which is POSTed verbatim in
`background.ts:314`. Verified: **14 of 14** DOM-channel GT PII values in the synthetic corpus appear
as raw text in the page and would be transmitted.

The architecture document (§4, §6.1) specifies typed placeholder substitution in the DOM channel.
The pixel channel implements it; **the text channel does not**. The README's claim that "a sensitive
value never gets a `value` field" is true but misleading — it omits that the value leaks via `label`.

**Fix:** substitute the pseudonym before building the node. `redact.ts` already has a working
`Pseudonymizer`; the content script needs one too, and `label` must be the token, never the text.

### 1.2 Coordinate-space mismatch: redaction boxes are wrong whenever the page is scrolled

`content.ts:170`:
```ts
return { x: r.left + scrollX, y: r.top + scrollY, ... }   // DOCUMENT coords
```
The captured frame is a **viewport** (tabCapture / captureVisibleTab both return viewport-relative
pixels). `redact.ts` scales the box and draws it directly onto that viewport frame.

On any page scrolled by S pixels, **every redaction is displaced by +S in y** — the password field
stays visible and a harmless region gets blacked out. The synthetic corpus is short and unscrolled, so
this never appears in the benchmark. It would appear within ten seconds of a real demo.

**Fix:** use `r.left`/`r.top` for the pixel box, and keep document coords in a separate field for the
DOM channel only.

### 1.3 The frame-diff gate skips redaction when the *data* changes

`main.ts:188`:
```ts
const domHash = String(domItems.length)
```

The "DOM hash" is the *count* of detections. Typing into a field, or a page filling in a name
programmatically, changes the PII content without changing the count. The gate then reports
"unchanged", returns `{ok:true, skipped:true}`, and the run continues with the **stale** manifest —
new PII is never redacted.

The gate's own design intent (§7) was to pair a pixel dHash with a *structural* DOM fingerprint, and
`lib/framediff.ts` already has `nodeStructuralHash` for exactly this. The call site passes the wrong
thing.

**Fix:** pass `nodeStructuralHash(snapshotNodes)`; at minimum hash the detected classes and values,
not the count.

### 1.4 The gate's confidence floor aborts on the very items it must cover

`redact.ts:214`:
```ts
const lowConf = entries.filter((e) => e.score < 0.5)
if (lowConf.length > 0) reasons.push(...)   // → abort the entire request
```

A low-confidence detection is *evidence of possible PII*, which is exactly when you must redact. As
written, the gate aborts rather than redacting. L0 semantic hits and L3 DETR hits routinely score
below 0.5, so this will fire on ordinary pages.

Related: L2 spans are pushed with `box: {x:0,y:0,w:0,h:0}`. `redact.ts` clamps to
`Math.max(2, 0*scale)` → a **2×2 pixel redaction at the origin**, and the "degenerate box" check
tests `e.box.w <= 0` *after* that clamp, so it never fires.

**Fix:** invert the floor (redact low-confidence items, only abort on *unclassified* regions); give
L2 text spans a real box via `Range.getClientRects()`, or route them through the text channel instead
of the pixel compositor.

### 1.5 SoM marks never reach the transmitted image

`background.ts:274` sends `marks: []` to the offscreen document. `redact.ts` draws badges from
`input.marks` — an empty array. **No Set-of-Mark badge is ever burned into `screen.webp`.**

SoM is the mechanism the project relies on to make `{"target":{"mark":17}}` resolvable. Without
badges in the image, the server cannot ground a mark reference, and M1 grounding accuracy cannot work.
`content.ts` computes marks correctly and renders them in a page overlay — they just never make it
into the frame that ships.

**Fix:** pass `msg.marks` (already on the message) through in `onSnapshotReady`.

### 1.6 The manifest signature is never verified

`signManifest` appends a literal `'00000000'` to a non-cryptographic FNV double-hash, and the server
never checks it — `signature` appears once in `app.py` as a field declaration, with no verification
path. The README presents this as tamper evidence. It is decorative.

**Fix:** either verify server-side with a real HMAC over the canonical manifest (key shared at
session start), or stop describing it as tamper evidence.

### 1.7 The two artifacts carry different frame hashes

`screen_state.frame_hash` is the literal `'pending'`; `manifest.frame_hash` is the gate's real hash.
The schema comment says they "must equal". Nothing checks it, on either side.

---

### 1.8 The CSP blocks the server call it is meant to protect

`wxt.config.ts` sets:
```ts
content_security_policy: {
  extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'",
}
```

The comment says this is what enforces "the offscreen document cannot reach the internet." True — but
`extension_pages` applies to **every** extension context, including the MV3 service worker, and
`background.ts:365` is the only place that calls `fetch(`${serverOrigin}/v1/agent/step`)`. With
`connect-src 'self'`, a request to `http://127.0.0.1:8000` is not same-origin and will be refused.

The privacy goal and the function are in direct conflict: the strictest reading of the policy that
protects the offscreen document also kills the T1 request.

**Fix:** keep the strict CSP on the offscreen document, and add the server origin explicitly to the
policy that governs the service worker:
```
connect-src 'self' http://127.0.0.1:8000
```
Better: derive the allowed origin from `serverOrigin` at build time so a remote deployment works too.

---

## Severity 2 — the three unmeasured metrics (60% of the rubric)

M1 (25%), M3 (20%), M5 (15%) are `None` in `run_metrics.py`. Combined with the neural layer being
disabled, **the project currently has measured evidence for M2 and M4 only — 40% of the weight.**

### 2.1 M3 is structurally impossible with the current corpus

`box: null` on **every** instance in all 20 synthetic forms. There is no ground-truth pixel geometry,
so box IoU cannot be computed at all. The recoverability half needs an OCR pass, which does not exist
in the project.

**Fix:** have `gen_synthetic.py` emit real pixel boxes (it controls the HTML, so it knows the layout),
and add an OCR step to the M3 script.

### 2.2 M1 needs a harness, not a JSON file

`tasks.json` defines 40 tasks with `checks` like `no_sensitive_fill`, but nothing runs them. This needs
a headless browser runner (Playwright loading the built extension) that drives each task, records the
outcome, and asserts the checks.

### 2.3 M5 needs a running vLLM once

The 700 ms figure is honestly labelled a design target. Keep it that way, but measure it at least once
end-to-end — a real p50/p95 is worth more than the target.

### 2.4 L2 is disabled, and the disabled layer still costs

`lib/l2policy.ts` sets every τ to 1.01 (`l2Enabled()` always returns false), yet `main.ts:203` still
computes `useL2 = plan?.L2 ?? true` and `main.ts:218` still calls `runL2(...)` — which tries to load
GLiNER (332 MB) and then BERT-NER on every cycle. The policy file is not consulted anywhere.

**Fix:** gate the call on `l2Enabled(plan?.L2 ?? true)` so the 332 MB download never starts. Right now
a "disabled" layer is silently doing real work.

### 2.5 Other gaps the README lists, confirmed

- L3 detectors wired but unmeasured → closed-shadow PII is 0/4 detected.
- Firefox build drops the pixel channel entirely (`wxt.config.ts` correctly omits `tabCapture`/
  `offscreen`, but then there is no compositing path at all).
- Delta-tile upload: schema supports it, server endpoint exists, **no client code produces tiles**.
- `tier0.answer()` is instantiated and never called. The T0 path in `background.ts:305` re-runs
  capture and stringifies the capture result as the "answer" — the local model is not in the loop.

---

## Severity 3 — smaller, worth fixing

| # | Finding | Location |
|---|---|---|
| 3.1 | `content:confirm` returns `{ok:true,confirmed:true}` without performing the action — confirming a destructive step does nothing | `content.ts:503` |
| 3.2 | `runL3Text` labels every text region `API_KEY` regardless of content — a placeholder, not a detector | `models.ts:331` |
| 3.3 | `streamId` from `getMediaStreamId` is obtained but `getUserMedia` may be called after it expires; no retry | `capture.ts:176` |
| 3.4 | `run` state (`RunState`) lives in the MV3 service worker, which Chrome kills aggressively — in-flight runs can be lost silently | `background.ts:41` |
| 3.5 | `mapL2Label` maps `MISC → DATE`, which is wrong and would mislabel spans if L2 were ever enabled | `models.ts:225` |
| 3.6 | Pixel channel never runs OCR, so "re-run L1/L2 on recovered strings" (§5) is unimplemented | `models.ts:313` |
| 3.7 | `valueClass` is only ever `'sensitive'` or `'masked'` — `'public'` is never produced, so the field carries no information | `content.ts:236` |

---

## What is genuinely strong

Worth saying plainly, because it is more than most submissions have:

- **The refusal to fake the neural layer.** Running GLiNER, discovering transformers.js cannot load
  it, running the threshold sweep anyway, and disabling the layer on measured evidence — while
  publishing the proof script — is the single most credible thing in the repo.
- **Layered invariants with tests.** 104 tests, `connect-src 'self'` CSP, a gate that returns
  `blob: null` and zero bytes, server-side 409 on an abort.
- **Honest reporting.** `NOT MEASURED` instead of placeholders; "this is a design target" instead of a
  fake waterfall; explicit per-browser capability notes.
- **Clean separation.** The service worker does no compute; the offscreen document is the only
  context that sees pixels; the content script is the only one that touches the page.

---

## Fix order

**Before any demo (blocks everything):** 0.1, 0.2, 1.1, 1.2, 1.5, **1.8**.

These six make the T1 path run and stop a real leak. They are small, local edits.

**Before judging (lifts the score):** 1.3, 1.4, 2.1, 2.2, 2.4.

Gate correctness, and turning M1/M3 from `None` into real numbers.

**Polish:** 1.6, 1.7, 2.3, 2.5, and all of §3.
