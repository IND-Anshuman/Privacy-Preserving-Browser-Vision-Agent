# SIH 2026 — Veil · Official PPT Deck Plan

**Source of truth:** the official template `SIH2026-IDEA-Presentation-Format.pptx`, downloaded from
`sih.gov.in/letters/2026/`. Slide count, headings and pointers below are extracted from that file,
not inferred.

---

## The rules (verbatim from the template's own "Important Pointers" slide)

> - Keep the maximum slides limit up to **six (6)**, *including the title slide*
> - Try to **avoid paragraphs** — post your idea in **points / diagrams / infographics / pictures**
> - Keep your explanation **precise and easy to understand**
> - Idea should be **unique and novel**
> - You can only use the **provided template** for making the PPT, without changing the idea-detail
>   pointers (mentioned in previous slides)
> - **You need to save the file in PDF and upload the same on the portal. No PPT, Word Doc or any
>   other format will be supported.**
> - You may **delete slide 7** (Important Pointers) when uploading

**Two things people get wrong:**
1. **The limit is 6 slides *including* the title slide.** So slides 1–6 are all you get, and slide 7
   (the pointers page) is deleted before upload. There is no room for a separate "thank you" or
   "contact" slide.
2. **Submit PDF, not PPTX.** The template gives you exactly 5 content slides to work with.

Slide size is 16:9 widescreen (12192000 × 6858000 EMU).

---

## Slide 1 — TITLE PAGE

Keep the template's own field labels, just fill the blanks.

```
SMART INDIA HACKATHON
2026

Veil — A Privacy-Preserving Browser Vision Agent

Problem Statement ID – SIH260XX      ← your PS number
Problem Statement Title – Privacy-Preserving Vision Agent which runs on browser
Theme – [as listed on the portal for your PS]
PS Category – Software
Team ID – [from portal]
Team Name – [as registered on the portal]
```

**Keep a two-line title** if it helps: the idea title, then a plain-language subtitle. The problem
statement title is long; the idea title is yours to choose.

---

## Slide 2 — IDEA TITLE

> Pointers: *Proposed Solution* · *Detailed explanation* · *How it addresses the problem* ·
> *Innovation and uniqueness*

**Title:** `Veil — a browser vision agent that hides sensitive data before anything is sent`

**Layout: three columns, points only. No paragraphs.**

### Block A — Proposed Solution
- Browser extension (Chrome + Firefox) + local server
- Two perception channels: pruned DOM accessibility tree **+** screen pixels
- **All** detection and redaction happen **on the user's device**
- Server receives only: page structure, a redacted image, and a redaction manifest
- Server returns a step-by-step action plan; extension executes it

### Block B — How it addresses the problem
- Raw screenshots to a server leak credentials, PII, medical and financial data
- Veil runs a **4-layer detector** before any network request exists
- A **fail-closed gate**: if coverage cannot be proven, **zero bytes are sent**
- Passwords are never hashed or pseudonymised — never sent, in any mode
- Unreadable regions (cross-origin frames, canvas, video) are **masked entirely**

### Block C — Innovation & Uniqueness
- **Typed pseudonyms** instead of blur: `[PERSON_1]`, `[AADHAAR_1]`
  → server still understands structure, fields and relationships; real values never leave
- **Fail-closed**, not best-effort — the gate can only pass or abort
- Runs a **27.4 MB PII model fully in-browser** (transformers.js + WebGPU)
- **Zero-network tier**: some tasks answered with a built-in on-device model, no request at all

**Visual:** the one-line transformation is your best asset — show it as the hero of this slide.

```
"Ankit Sharma (9876543210, ankit@acme.in) owes ₹42,000"
   ↓  everything below happens ON DEVICE
"[PERSON_1] (contact: [PHONE_1], email: [EMAIL_1]) owes ₹42,000"
```

---

## Slide 3 — TECHNICAL APPROACH

> Pointers: *Technologies to be used* · *Methodology and process for implementation*

**Left half — technology stack (as a compact table or icon grid):**

| Layer | Technology |
|---|---|
| Extension | TypeScript, **WXT** → one codebase, Chrome MV3 + Firefox MV3 |
| Local inference | **Transformers.js v4** + ONNX Runtime Web, **WebGPU** (WASM fallback) |
| PII model | `bert-small-pii-detection-ONNX` — 27.4 MB q8, 24 PII classes, ~4 ms/string |
| Face / text detection | yolov10n 3 MB int8 + text-region finder |
| OCR | TrOCR small (printed) for canvas / image text |
| Server | **FastAPI** + **vLLM V1** (prefix caching, XGrammar constrained decoding) |
| Privacy gate | OffscreenCanvas + GPU compositing, frame-diff gating |

**Right half — pipeline diagram.** This is the slide where a diagram beats any paragraph:

```
┌────────────── DOM channel (structure, zero pixels) ─────────────┐
│ accessibility tree · roles · field types · bounding boxes       │
└──────────────────────────┬──────────────────────────────────────┘
┌────────────── PIXEL channel (what DOM cannot see) ──────────────┐
│ faces · text inside canvas · text inside images/video           │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │   L0 semantics → L1 regex → L2 NER → L3   │
        └──────────────────┬───────────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │   REDACTION + FAIL-CLOSED GATE           │  ← the only exit
        │   can it prove everything is hidden?      │
        └──────────────────┬───────────────────────┘
            yes ↓                    no ↓
   structure + redacted       ZERO BYTES
   image + manifest           leave the device
                           ▼
        server VLM → action plan → extension executes
```

**Add a working-prototype screenshot strip** along the bottom: the side panel showing "N items
hidden", the DevTools Network tab with the request body, the "what the assistant saw" tokens.

---

## Slide 4 — FEASIBILITY AND VIABILITY

> Pointers: *Feasibility analysis* · *Potential challenges and risks* · *Strategies for overcoming them*

This is the slide that separates a team that measured from a team that guessed. **Lead with the
measurements.**

### Feasibility (measured, not claimed)
- **203 automated tests pass**; both browser targets build clean in ~3 s
- Detection on a 20-form corpus with exact ground truth: **P = 0.96, R = 0.80, F1 = 0.88**
- Client compute: **17.9 ms** for detection, **27.9 ms** for the change gate (~46 ms per cycle)
- Server verified end-to-end: **16/16** API checks pass against a live server
- Extension ships at **212 kB**, models load once and are cached

### Challenges → strategies (a two-column table, not prose)

| Challenge | Strategy |
|---|---|
| Some PII only exists as pixels (canvas, video, photos) | 3rd detection layer on-device; unreadable regions masked entirely rather than sent |
| Screenshots can reveal far more than the task needs | The **gate refuses to send** rather than sending and hoping |
| A rerendered page can move a target under the agent | Targets are re-resolved live before every click; never a blind click |
| A malicious page can try to hijack the agent | Page text is passed as untrusted data, never as instructions; destructive actions always need a human |
| Laptops vary from desktop to 800 MB | Runtime capability detection with a WASM fallback; the cascade shrinks under load instead of stalling |

**The re-derivation story is your best "we learned something" beat:** an early model had no PII
classes, so we ran a measured threshold sweep and shipped a **per-class policy** instead of a
global one — because a redaction layer's recall and precision are not symmetric: a false positive
costs a useless black box, a false negative leaks.

---

## Slide 5 — IMPACT AND BENEFITS

> Pointers: *Potential impact on target audience* · *Benefits (social, economic, environmental)*

### Who it helps — use the three personas as icons
- **Enterprise & corporate users** — automate HR / ERP / CRM portals without breaching data
  governance, SOC 2, GDPR or HIPAA
- **Privacy-conscious individuals** — get help on forms containing banking details, passwords and
  personal photos, without shipping that screen to a cloud model
- **Auditors & compliance teams** — a tamper-evident manifest plus a visible ledger of every byte
  that left the device

### Benefits (three columns)

**Social**
- Makes private, on-device AI assistance an option for people who cannot risk sending a screen to a
  cloud — bank forms, medical portals, HR documents

**Economic**
- No raw context to a model provider, so no per-screen data cost
- Works offline / on-device for common tasks
- Auditable by design: helps regulated industries adopt agentic automation at all

**Environmental**
- On-device detection means a trivial "what's on my screen?" never leaves the laptop — fewer
  cloud inferences for the questions that did not need one

**Optional footer line, if space allows:** a privacy benchmark for desktop agents, complementing
the first mobile privacy benchmarks published in 2026.

---

## Slide 6 — RESEARCH AND REFERENCES

> Pointer: *Details / Links of the reference and research work*

Keep it to **6–8 short lines** with real citations. Strongest first:

**Foundational work we built on**
- **Set-of-Mark prompting** (Microsoft) — numbered visual badges that let a vision model say
  *"click mark 17"* instead of guessing a location
- **Transformers.js v4** — on-device model inference in the browser over WebGPU
- **ONNX Runtime Web** — GPU-accelerated inference outside a server
- **vLLM V1** + **XGrammar** — fast, schema-constrained structured output on the server
- **Microsoft Presidio** — the reference taxonomy for PII classes

**Recent research (2026) that directly validates this problem**
- **CAPED — Context-Aware Privacy Exposure Defense for Mobile GUI Agents** (arXiv:2606.12666) —
  names "incidental visual privacy exposure": a screenshot exposes data unrelated to the task
- **PriMobiBench** (arXiv:2609.13873) — the first benchmark for privacy leakage in GUI agents

**Browser-platform direction**
- **Chrome built-in AI (Prompt API)** — on-device model with image input, which is what makes a
  genuinely zero-network tier possible

---

## Before you submit — checklist

- [ ] Built from the **official template**, pointers not removed or renamed
- [ ] **6 slides total including the title slide**
- [ ] Slide 7 (Important Pointers) **deleted**
- [ ] **Exported to PDF** and the PDF uploaded — PPTX will be rejected
- [ ] Points/diagrams, not paragraphs
- [ ] Team ID and Team Name match the portal registration exactly
- [ ] PS ID, title, theme and category match the portal listing

---

## Design notes

- 16:9 widescreen, as the template already is — do not change the slide size
- The template's own layout already has heading + content zones; fill them rather than re-laying out
- Two assets carry the deck: the **pseudonym transformation** (slide 2) and the **pipeline diagram**
  (slide 3)
- Where you have real numbers, use them — measured precision, test counts, byte sizes, build time.
  Judges can tell the difference between a measured claim and a marketing one.
