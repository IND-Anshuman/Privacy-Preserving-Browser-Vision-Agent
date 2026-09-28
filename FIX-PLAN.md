# Fix plan — all five waves complete

**Status: DONE and verified. Every number below came from a run; see README.md
for the tables and the honest failure notes.**

| # | Finding | Status | Evidence |
|---|---|---|---|
| 0.1 | `frame_hash: 'pending'` failed schema on every T1 run | FIXED | real 16-hex fingerprint; the server rejects a missing one with 422 too |
| 0.2 | the plan was parsed and dropped | FIXED | `executePlan()` in background.ts |
| 1.1 | **raw PII shipped as `label`** | **FIXED** | **0/212 leaked, measured** |
| 1.2 | boxes in document coords | FIXED | `rectOf` is viewport; `documentRectOf` kept for the DOM channel |
| 1.3 | gate hashed a detection *count* | FIXED | hashes the redacted structural fingerprint |
| 1.4 | `lowConf` predicate inverted | FIXED | gate now aborts only on what it never classified |
| 1.5 | `marks: []` sent to the compositor | FIXED | marks ride on `snapshot:ready` |
| 1.6 | uninspectable frames flagged, not redacted | FIXED | `OPAQUE_REGION`, redacted whole, gate aborts if uncovered |
| 1.7 | canvas/video invisible to every rule | FIXED | both fail-closed until L3 clears them |
| 1.8 | offscreen CSP too loose | FIXED | per-context, `connect-src 'self'` |
| 2.3 | L2 was "disabled but still loaded 27 MB" | FIXED | gated by `admitL2` |
| 2.4 | `lowConf`/gate inversion | FIXED | see 1.4 |
| 2.5 | delta tiles unwired server-side | FIXED | cropped from the *redacted* canvas, re-composited server-side |
| 3.1 | `content:confirm` was a no-op | FIXED | re-resolves the mark and clicks |
| 3.7 | `valueClass` never `'public'` | FIXED | three-way now, and the server prompt can use it |
| — | **server `pixel_derived` vs client `pixelDerived`** | **FIXED** | 422 on every real request; `bench/test_contract.py` now pins it |
| — | **two L3 "models" were not models** | **FIXED** | yolov10n has no face class; `runL3Text` called the face detector |
| — | shadow DOM not implemented at all | FIXED | open roots walked, sealed hosts fail closed |

### Final measured state

```
extension   162 tests, tsc clean, chrome 188.13 kB, firefox 188.04 kB
server      17/17 checks, 5/5 contract checks
M2          P=0.982  R=0.799  F1=0.881   (268 GT instances, 20 forms)
cascade     naive union F1 0.788 -> 0.164  (2,444 FP) — hence PERSON-only
leakage     text 0/212 · box 6/212 uncovered (2.8%)
M3          coverage 12/12 · leakage 0/12 · mean IoU 0.045 (by construction)
L3 canvas   12/12 covered, 9.6 ms/canvas, real browser
M5          client p50 17.94 ms · server floor p50 2.0 ms · T1 NOT MEASURED
```

### What the corrections cost and bought

The L2 story reversed three times, and each reversal came from measuring:

1. "The neural layer doesn't work" — true of `bert-base-NER`, false in general.
   Checking the Hub found `bert-small-pii-detection-ONNX` (24 PII classes, 27 MB).
2. "It works, so the cascade improves F1" — **false.** Measured: naive union drops
   F1 from 0.788 to 0.164 with 2,444 false positives. The per-class policy is not
   a compromise, it is the only defensible configuration.
3. "The benchmark says L2 contributes nothing" — false, twice. The harness still
   used the rejected model, and a bare `catch` swallowed an ONNX batch error.

Every one of those looked like a *result*. None of them was.

---

## Original wave plan (superseded by the table above)

---

## 0. The correction, accepted and verified

I was wrong. My README claimed *"no browser-loadable NER has PII classes"*
based on `Xenova/bert-base-NER` returning nothing for an email. That was a true
observation of a **CoNLL-2003** model, generalised to the whole family. The
generalisation was the error, not the observation.

Verified independently before acting on it (HF API, then live execution):

| claim | verification |
|---|---|
| repo exists, Apache-2.0, `token-classification` | ✅ API 200 |
| 24 PII classes (48 with B-/I-) | ✅ read from `config.json` |
| q8 weights 27.4 MB | ✅ 28,748,527 bytes downloaded |
| it runs | ✅ raw output below |

**Raw model output, my own run:**

```
"Contact Divya Banerjee at divya.banerjee@mailbox.net or 6117651412."
    B-PERSON         0.979
    B-EMAIL_ADDRESS  0.790
"Card 4111111111111111 expires 05/09/1959, SSN 123-45-6789."
    B-DATE_TIME      0.894
    B-US_SSN         0.383
```

### What I measured on our corpus

| | P | R | F1 |
|---|---|---|---|
| L0+L1 only | 0.954 | 0.669 | 0.787 |
| L2 only (raw) | 0.119 | 0.569 | 0.197 |
| Tuned cascade | 0.720 | **0.798** | 0.757 |

**PERSON: 42/54 → 53/54.** The biggest measured weakness is closed.

### But the honest reading is not "L2 wins"

Overall F1 goes **down** 0.030, because L2 emits 1185 spans of which ~1044 are
false positives — 337 of them LOCATION alone. So the shipping decision is
**per class**, and it is now in `lib/l2policy.ts` with tests:

- **PERSON: enabled** (τ=0.99) — the class regex structurally cannot reach.
- **Everything else: disabled** (τ=1.01) — L1 already owns those exactly, and
  the measured gain was zero at a real precision cost.

That is the correct call for a redaction layer: a false positive costs a useless
box, a false negative leaks. And it is exactly what the per-class thresholds in
§5 exist for — we now have a measured second column for the cascade-delta table
instead of a prediction.

### Two bugs this surfaced in my own code

1. **The API returns no character offsets** — only `entity/score/index/word`.
   My merge fell back to `indexOf(word)` with no cursor, producing `start: -1`
   and empty text, which scored zero. Fixed with a cursor walk that strips
   `##` and skips `[CLS]/[SEP]`. This is why the first two runs returned 0 spans
   despite the model working.
2. **Batched input returns an ambiguous shape.** A flat token list for one
   string, nested for many; treating tokens as rows silently yields nothing.
   Now normalised, one string per call.

Both are pinned by tests in `tests/l2policy.test.ts`.

### What I did NOT do

I did not take the recommendation's framing at face value. "PERSON recall
0.98 confidence" is not a recall figure — the measured recall is 53/54 with
precision 0.13 on that class. And the recommendation's claim that the tuned
cascade would improve F1 did not hold; it dropped. Both are in the tables above.

---

## Wave 0 — make T1 run (blocks everything)

| # | Fix | Note |
|---|---|---|
| 0.1 | `frame_hash: 'pending'` → real hash | Fails schema validation; **every T1 run dies here today** |
| 0.2 | Execute `plan.steps` | No execution loop exists; the agent observes but does not act |
| 2.4 | Gate `runL2` on `l2Enabled()` | The policy file was imported nowhere; a "disabled" layer was loading 332 MB every cycle |

0.1 needs a hash the DOM channel and pixel channel agree on. Use
`domStructuralHash` over the pruned snapshot. This also dissolves 1.7 — the two
hashes are produced at different moments, so assert "manifest is authoritative
for the image" rather than an impossible equality.

---

## Wave 0 + §1.1 — DONE, verified

| # | Fix | Status | Evidence |
|---|---|---|---|
| 0.1 | `frame_hash: 'pending'` broke every T1 run | FIXED | real 16-hex structural fingerprint; carried on `snapshot:ready` |
| 0.2 | plan never executed | FIXED | `executePlan()` loop in background.ts |
| 1.5 | `marks: []` sent to compositor | FIXED | marks are part of `snapshot:ready`, forwarded to offscreen |
| 3.1 | confirm was a no-op ack | FIXED | `content:confirm` re-resolves the mark and clicks |
| 1.2 | boxes in document coords | FIXED | `rectOf` → viewport; `documentRectOf` kept for the DOM channel |
| 1.3 | gate hashed a count | FIXED | hashes the redacted structural fingerprint |
| 1.4 | `lowConf` inverted | FIXED | predicate now reads "is NOT low confidence" |
| 1.8 | offscreen CSP too loose | FIXED | per-context CSP, `connect-src 'self'` on offscreen |
| 2.4 | ungated L2 | FIXED | gated by `admitL2` |
| **1.1** | **raw PII shipped as `label`** | **FIXED** | **0 of 212 leaked, measured** |

`tsc` clean · **143 tests** · chrome 185.64 kB · firefox 185.56 kB · server 17/17.

### §1.1 took three attempts to measure honestly

The pseudonymizer is now `lib/pseudonym.ts`, used by the content script, so
`label` is a token and never a string. Three separate measurement bugs got in the
way, each producing a confident and wrong number — all documented in
`bench/measure_leakage.ts`, because the failure mode was always "report clean":

1. **0% that wasn't.** The audit searched `body.textContent`, which never
   contains an `<input value>`. It examined **104 of 212** instances and called
   it clean while an ADDRESS sat in the payload.
2. **90% that wasn't either.** Closing that gap by putting input values *into*
   the searched string inverted the error — `screen_state.json` carries no
   `value` field for a sensitive node **by contract**. Searching a payload that
   cannot contain values measures nothing.
3. **The real number.** Text channel 0/212. Box coverage 6/212 (2.8%)
   (`BANK_ACCOUNT×4`, `ADDRESS×2`). A value fails either channel independently,
   so both are now reported.

Two real product bugs surfaced, both in `lib/pii.ts`:
- `autocomplete="shipping street-address"` fell through to the generic PERSON
  branch — only the `billing` prefix was handled.
- No ADDRESS rule existed for prose, so an address repeated in a summary
  paragraph had no detector at all.

**Correction to a number I reported earlier: L0+L1 micro precision is 0.908, not
0.980.** The 0.980 came from the same value-attribute gap — half the instances
were never scored. Chasing it also showed a bare-6-digit-PIN rule I'd added
measured ADDRESS precision **0.08** (tp=2, fp=22), so I removed it rather than
keep it at a lower score.

## Wave 1 — the privacy-critical defects (remaining)

| # | Fix | Why it matters |
|---|---|---|
| **1.1** | Pseudonymize before building the node | **The actual leak.** `label` carries raw `textContent`; `valueClass: 'sensitive'` is a flag *about* a value, not a substitution. Reorder: classify → pseudonymize → build. Extract `Pseudonymizer` to `lib/pseudonym.ts` so content and offscreen share one implementation. **Test: no corpus GT string may appear anywhere in the serialized `screen_state`** — must fail today |
| **1.2** | `rectOf` → viewport coords | `r.left + scrollX` is document space; the frame is a viewport. Every redaction displaced by S when scrolled; corpus never scrolls so the benchmark misses it |
| **1.5** | Pass marks through | `marks: []` means no badge is burned into `screen.webp`, so `{"target":{"mark":17}}` is ungroundable. M1 cannot work |
| **1.8** | Split the CSP | `connect-src 'self'` applies to the worker too, so the one `fetch` that makes T1 work is refused. Keep the strict page-level CSP on the offscreen doc; add only the configured origin to the manifest policy. **Test both directions** |

---

## Wave 2 — gate correctness

- **1.3** — `domHash = String(domItems.length)` is a *count*. Typing changes PII
  without changing the count → gate says "unchanged" → **stale manifest ships
  and new PII is never redacted.** Hash classes and pseudonymized values.
- **1.4** — the gate *aborts* on `score < 0.5`, i.e. it refuses to send exactly
  when there is evidence of PII. **Invert it**: redact low-confidence items,
  abort only on regions never classified. Move the degenerate-box check before
  the clamp (it can never fire after it).

---

## Wave 3 — L3, the remaining privacy gap

The canvas gap (4/16) and closed-shadow gap (0/4) are the only non-zero leak
rates left. Plan, in the order I'd do it:

1. **OCR over detected text regions** — `ocrRegions()` is now implemented in
   `models.ts`; it needs a real measurement against the canvas adversarial
   cases. This is the only defence for canvas/video PII.
2. **Swap DETR → YOLOv10n** (3 MB int8, NMS-free) — 14× smaller and removes the
   hand-rolled NMS. Done in code; needs download + measurement.
3. **Closed shadow roots** — the architecture promises a geometric fallback and
   it is currently 0/4. Either implement or say so plainly.

---

## Wave 4 — make the missing metrics possible

- **M3**: `gen_synthetic.py` must emit real pixel boxes (it owns the layout),
  plus a recoverability check. Label the recoverability step a **proxy, not
  OCR**, in the output.
- **M1**: a Playwright runner driving the 40 tasks against observable state
  (ledger, manifest, network), not model self-report.
- **M5**: measure once with a running vLLM; keep the target labelled as a
  target until then.

---

## Wave 5 — the rest

1.6 signature (delete or real HMAC — I favour deleting and stopping the
claim) · 2.3 · 2.5 T0 path is fake / delta tiles unwired / Firefox has no
compositing path · 3.1 `content:confirm` no-op · 3.2 text-region class
(now neutral, documented) · 3.4 SW run state · 3.5 `MISC → DATE` · 3.7
`valueClass` never `'public'`.

---

## Not planned, deliberately

- **Re-introducing GLiNER.** It does not load. The correction is the small
  model, not the big one.
- **Fabricating M1/M3/M5.** If the harness doesn't land, the table keeps
  saying NOT MEASURED.
- **Claiming the cascade improves F1.** It does not; the per-class policy is
  what makes it worth having at all.

---

## State

`tsc` clean · **128 tests** · both browsers build · server 17/17 · L2
correction measured and shipped per-class.

| item | status |
|---|---|
| L2 model swap + measurement | **done** |
| Subword/offset merge + tests | **done** |
| Per-class policy + tests | **done** |
| YOLOv10n + OCR wiring | code done, unmeasured |
| Wave 0–5 | planned |
