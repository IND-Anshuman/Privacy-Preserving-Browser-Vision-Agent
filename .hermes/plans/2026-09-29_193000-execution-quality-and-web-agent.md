# Veil — Execution Quality + Web Agent: Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the extension's execution loop honest and verified, then build a local web agent that stores run history and answers post-hoc questions about past runs.

**Architecture:** Two independent parts, sequenced so Part 1 lands first.

Part 1 hardens what already exists. The findings below are not hypothetical — each cites the line that produces the failure.

Part 2 adds a *new surface*, not a new architecture. The extension remains the sole capture/redaction/execution authority; the web agent is read-mostly and never executes anything.

**Tech Stack:** TypeScript (WXT, MV3), FastAPI + uvicorn, stdlib `sqlite3` (no ORM), vanilla HTML/CSS/JS for the web UI (no build step), vitest, plain-python bench harnesses.

---

## Part 0 — Findings this plan is built on

All verified by reading the code on 2026-09-29. These are the failure modes the work exists to remove.

> **Severity ordering changed after a parallel audit.** F0a–F0d below are worse than
> anything in my first pass: one of them hangs the user for 60 seconds and then
> blames them, and another clicks every iframe at once. **Do Part 0 first, ahead of
> everything, and treat it as a bugfix rather than refinement.**

### F0a. Confirmation deadlock — the user is never shown the confirm card

This is the worst defect found.

The chain, verified end to end:

1. `content.ts` never sends `execute:confirm_required` (see F1).
2. `background.ts:501` therefore sends `panel:answer` with `tier: 'confirm'` instead.
3. `panel.tsx:183` handles that by calling `push('warn', msg.text)` — which **does not set `state.confirm`**.
4. `state.confirm` is assigned in exactly one place: `panel.tsx:193`, inside the `execute:confirm_required` branch.
5. So the panel never renders a decision card. `waitForConfirmation` (`background.ts:520-539`) polls `confirmations` for 60 seconds, finds nothing, and resolves `false`.
6. `background.ts:504` then reports `'Cancelled at your request.'`

**Consequence:** any plan needing confirmation **silently stalls for 60 seconds, then reports that the user cancelled a run they never cancelled.** The destructive-action interlock — the project's central safety property — is unreachable in production. A submit/pay/delete step never gets approved, and the user is told they refused it.

This is Task 0.1. Nothing else in Part 1 matters until it is fixed.

### F0b. Every iframe receives every action and clicks simultaneously

`background.ts:194` calls `chrome.tabs.sendMessage(tabId, msg)` with **no `frameId`**, while the content script registers with `allFrames: true` (`content.ts:810`).

**Consequence:** a plan targeting mark 17 in the top frame is also delivered to every same-extension iframe, where mark 17 resolves independently against that frame's DOM. The click happens in all of them at once. `frame:crossorigin` (`messages.ts:110`) carries a `frameId` and is defined — but has no producer anywhere in the repo.

### F0c. `run.turn` is never incremented — delta tiles are permanently dead

`run.turn` is initialised to `0` (`background.ts:247`) and never incremented: `turn++` → 0 matches, `turn +=` → 0 matches. The request always sends `turn: 0`.

The delta-tile gate is `const useTiles = run.turn > 1 && ...` (`background.ts:403`). With `turn` pinned at 0, **this is false on every request, forever.**

**Consequence:** §7 delta tiles — a documented feature with measured CPU numbers, a server endpoint (`/v1/agent/tiles`), and PR curves — never fires once. The server's replan cap also never sees a second turn, so multi-turn automation is single-turn in practice.

### F0d. The dead safety net: `check_plan_against_state` is never called

`server/actions.py:88-111` implements plan-against-current-state validation — it rejects marks that no longer exist and refuses fills into hidden/sensitive fields. Its docstring claims it catches exactly the failure modes of F0b and staleness.

It is called from `bench/test_server.py:161,170` and **nowhere else**. `server/app.py` never calls it.

**Consequence:** the test suite passes on a function production never executes. Separately, `schema.ts:237` states the frame-state contract — *"Frame this state was sampled against; must equal manifest.frame_hash"* — and a grep for any `frame_hash` equality comparison across all `.ts/.tsx/.py` returns **zero matches**. A plan computed against screen A executes against screen B.

### F0e. A failed step does not stop the run

`background.ts:498` destructures `r.ok` and **never reads it**. Only `r.needsConfirm` is inspected. Any other failure falls through to `executed++` (`background.ts:510`) and the loop proceeds to step N+1 against whatever state the failure left behind. No backoff, no error surfaced, no abort.

Combined with F2 (below), this is the "green checkmark, nothing happened" failure.

### F1. `execute:done` is a dead message — the step list never updates

`content.ts` sends exactly **one** runtime message in the entire file: `snapshot:ready` at `content.ts:727`. `execute:done` and `execute:confirm_required` are defined in `messages.ts:108-109` and handled in `panel.tsx:191-204`, but their only senders are `bench/make_panel_preview.py:88,105-107` — a mock.

`background.ts` only *listens* for it (`L226`, `L635`).

`content.ts:551` `executeAction(runId, index, act)` takes an `index` parameter, and the only caller passes a hardcoded `0`:

```ts
case 'content:execute':
  return executeAction(msg.runId, 0, msg.action as PlanAction)   // index always 0
```

**Consequence:** every execution reports `actionIndex: 0`. The panel's per-step `done`/`failed` badge can never resolve to the right step, and because no one sends the message at all, **no step ever gets a status**. The user sees a plan and a spinner, never a result.

### F2. `ok: true` is returned unconditionally — failure is unrepresentable

`content.ts:634` is the end of every action path:

```ts
return { ok: true, status: act.action, ms: performance.now() - t0 }
```

There is no branch that returns `ok: false`. A `click` on a disabled button, a `fill` on an element that rejected the value, a `select` where `el` was not an `HTMLSelectElement` (see `content.ts:609` — the `if` silently no-ops) all report success.

**Consequence:** the panel renders `step.status = msg.ok ? 'done' : 'failed'` — a branch that can never be false. A failed automation is visually identical to a successful one.

### F3. Nothing verifies that an action took effect

`verify` appears **0 times** in `content.ts`. No post-action DOM read, no value check, no navigation wait.

**Consequence:** `click` → the handler throws, or the element was a no-op, or the SPA ignored it. The run reports 7/7 steps done. The user finds out when the form isn't submitted.

### F4. No settle/wait between steps

`background.ts:472-511` loops steps back-to-back. The only wait is `wait_for` (`background.ts:477`) and a single `await new Promise` in `content.ts:625` (capped at 2000 ms).

**Consequence:** a step that triggers an async re-render invalidates the marks for every subsequent step. `resolveMark` (`som.ts`) handles this correctly — it re-resolves against live candidates and returns `lost` when it can't — so the failure mode is *safe* (it asks the user) but *noisy*: step 4 of 7 raises "that control is no longer on the page" for a page that simply hadn't finished loading.

### F5. `/v1/agent/outcome` exists, is fully implemented, and is called by nothing

The extension calls exactly two endpoints: `/health` (panel) and `/v1/agent/step` (background). Grep confirms zero references to `/v1/agent/outcome` and `/v1/agent/validate` anywhere in `extension/`.

The server's own docstring for `/outcome` says:

> *"Without it the server cannot tell 'the step worked' from 'the step silently did nothing', and a failed automation looks exactly like a successful one until the user notices."*

This endpoint is the designed fix for F2/F3 and it is unwired.

### F6. Session state is in-memory and dies on restart

`server/session.py`: `MAX_SESSIONS = 256`, `dict`-backed, no persistence (`sqlite|sqlalchemy|postgres|redis` → 0 matches). `last_seen` exists but TTL is never enforced as eviction.

**Consequence:** restart the server and every conversation, every cost total, every "the user declined this" record is gone.

### F7. The redacted image is discarded after the response

`/v1/agent/step` receives `image_b64`, streams back a plan, and logs `len(req.image_b64)` — a byte count, never the bytes. Nothing persists it.

**Consequence:** "what did that form look like when it failed?" is unanswerable today. This is the single biggest constraint on Part 2 and it needs an explicit decision (P2-0 below).

### F8. No web assets, no static serving

`StaticFiles|mount(|FileResponse|HTMLResponse|Jinja|templates` → **0 matches** in `server/app.py`. `server/requirements.txt` is the only dep manifest (6 lines, no ORM). `jinja2`, `sqlalchemy`, `aiosqlite` are **not installed**; stdlib `sqlite3` is available.

### F9. The Dockerfile sets the exact CORS value the server now refuses to start on

`server/Dockerfile` still contains `VEIL_ALLOWED_ORIGINS=chrome-extension://*`. `app.py` refuses a wildcard origin outright (it raises rather than honour it). So the container as shipped **does not boot** — a direct regression from the CORS hardening in `7a6935b`, and one that only appears in Docker, never in the local dev loop that gets tested.

`docker-compose.yml:67` is already correct (`dev`).

Fix in Task 0.6, before any Part 2 deployment work.

### F10. The server keeps the current frame in RAM and never exposes it

`VLLMClient.store_frame` holds one base frame per session in `self._frames[session_id]` (`vllm_client.py:136-137, 238-242`), overwritten each turn, unbounded, no eviction. `GET /v1/agent/session/{id}` explicitly excludes it (`app.py:344-347`).

**Consequence for Part 2:** "what did that page look like when it failed?" is answerable *only for the current turn* and only in RAM. This is why Task 2.0 is a real decision and not a formality.

### F11. The session store's "no persistence, by design" is now contradicted

`session.py:99-102` says:

> *"A privacy tool that writes user task history to disk has created a new dataset to protect. Sessions live in the process and die with it."*

That reasoning was sound for session memory. **Part 2 deliberately reverses it**, so the docstring must change with the code — otherwise the next reader inherits a comment that contradicts the design. Task 2.1 includes this.

### F12. Stored transcripts become a stored injection vector

`injection.py` scans page labels on the way *in* (`app.py:182-195, 413`) and fails open — findings are logged and injected as "treat as data", never blocking. So a stored transcript is untrusted page-derived text that was scanned once, at write time.

Answering a question about stored history re-enters that text into a prompt. **`scan_many()` must run on read, not just on write**, or a page that planted an instruction in turn 1 gets to act on it in turn 40.

Related: `manifest_privacy` RNG is seeded per session (`manifest_privacy.py:100-108`), so re-summarizing a *stored* manifest would re-noise already-noised counts. **Freeze released counts at write time** rather than recomputing them per read.

---

## Sequencing

| | Depends on | Why |
|---|---|---|
| **Part 0** (blocking defects) | nothing | F0a makes the safety interlock unreachable; F0b clicks every iframe; F0c kills a shipped feature. These are not refinements. |
| **Part 1** (execution) | Part 0 | Fixes the honesty bug. The web agent's history is worthless if it records "success" for actions that failed. |
| **Part 2** (web agent) | Part 1's `/outcome` wiring | The history store consumes the outcome feed. Building the store first means reworking it. |

**Do Part 0 first, ahead of everything.** It is a bugfix pass, not enhancement work, and two of its six items (confirmation deadlock, all-frames execution) are user-visible safety failures. **Then Part 1, even though Part 2 is the bigger visible win** — a history UI that faithfully records a broken execution loop is worse than no history UI.

---

# Part 0 — Blocking defects (fix before anything else)

These are not refinements. F0a makes the safety interlock unreachable; F0b makes actions fire in every frame; F0c silently disables a shipped feature.

## Task 0.1: Fix the confirmation deadlock (F0a)

**Objective:** Make the destructive-action interlock reachable. Right now no destructive step can ever be approved.

**Files:**
- Modify: `extension/entrypoints/sidepanel/panel.tsx:183`
- Test: `extension/tests/confirm.test.ts` (new)

**Step 1: Write the failing test**

The panel must set `state.confirm` — not just print a warning — when the SW asks for a decision:

```ts
describe('panel:answer with tier=confirm opens the decision card', () => {
  it('sets state.confirm so the user can actually answer', () => {
    apply({ kind: 'panel:answer', runId: 'r1', text: 'Submit this order?', tier: 'confirm' })
    expect(state.confirm).not.toBeNull()
    expect(state.confirm?.label).toBe('Submit this order?')
  })
})
```

**Step 2:** Run → FAIL (`state.confirm` stays null; current code only calls `push('warn', ...)`).

**Step 3: Implement**

```ts
if (msg.tier === 'confirm') {
  // This branch used to only push a chat line, so the decision card never
  // rendered and waitForConfirmation polled a confirmations map that nothing
  // could write for 60s, then reported "Cancelled at your request" for a run
  // the user never cancelled. The card IS the interlock; a warning bubble is
  // not.
  state.confirm = { runId: msg.runId, actionIndex: -1, label: msg.text }
  push('warn', msg.text)
}
```

`actionIndex: -1` because `panel:answer` carries no index. The panel's approve/decline path must send `content:confirm` with that index, and the SW must route `-1` to the pending confirmation. **Verify that routing explicitly** — if the index is wrong the card renders but approval still hangs, which is the same bug wearing a hat.

Consider the cleaner alternative: have the content script actually send `execute:confirm_required` (it already has the actionIndex), and keep `panel:answer` for text only. That removes the `-1` sentinel entirely. **Prefer this** — it fixes the cause rather than the symptom, and `execute:confirm_required` already exists in the schema and the panel handler.

**Step 4:** tests PASS. **Step 5:** `tsc` + full vitest.
**Step 6: Commit** — `git commit -m "fix: the destructive-action interlock was unreachable"`.

**Manual gate — not automatable:** run a task whose plan contains a `submit`. The card must appear, "No, skip it" must decline, and the run must end with a *declined* status, not "Cancelled at your request."

## Task 0.2: Scope actions to the originating frame (F0b)

**Objective:** Stop every iframe from executing the same action.

**Files:**
- Modify: `extension/lib/messages.ts` (`snapshot:ready` gains `frameId`)
- Modify: `extension/entrypoints/content.ts` (send `frameId`; guard execute)
- Modify: `extension/entrypoints/background.ts:194` (`toContent` accepts a frameId)
- Test: `extension/tests/frame.test.ts` (new)

**Step 1: Write the failing test** — with two frames registered, a `content:execute` for frame 0 is not delivered to frame 1.

**Step 2:** Run → FAIL.

**Step 3: Implement**

- `content.ts`: include `frameId: chrome.runtime.getURL() ? window.frameElement ? 0 : chrome.runtimeMessage frame id : 0`. In practice, use `chrome.runtime.sendMessage` to report the sender's frame id, or target the top document with `{ frameId: 0 }` on the SW side.
- Simplest correct fix: **have the content script ignore `content:execute` when it is not the frame the plan was built from.** Store the `frameId` reported at `snapshot:ready` and compare. This fails safe (an unexpected frame does nothing) rather than requiring every send to be addressed.
- Also give `toContent` an optional `frameId` and pass `{ frameId }` as the third argument to `chrome.tabs.sendMessage` where a specific frame is intended.

**Step 4:** tests PASS. **Step 5:** `tsc` + vitest.
**Step 6: Commit** — `git commit -m "fix: actions were executing in every frame at once"`.

## Task 0.3: Increment `run.turn` (F0c)

**Objective:** Re-enable delta tiles and multi-turn replanning.

**Files:**
- Modify: `extension/entrypoints/background.ts` (`executePlan` end, and wherever a turn completes)
- Test: `extension/tests/turns.test.ts` (new)

**Step 1: Write the failing test** — two consecutive requests in one session send `turn: 0` then `turn: 1`.

**Step 2:** Run → FAIL (both are 0).

**Step 3: Implement** — increment once per completed turn, after the plan finishes executing:

```ts
const run = runs.get(runId)
if (run) { run.stage = 'done'; run.turn += 1 }
```

Note `stage(runId, 'execute', 0)` at `background.ts:513` passes a hardcoded `0` — the waterfall shows every execution as 0 ms. Fix that in the same commit; it is the same class of "constant where a measurement belongs" bug.

**Step 4:** tests PASS. **Step 5:** `tsc` + vitest.
**Step 6: Commit** — `git commit -m "fix: run.turn never incremented, so delta tiles never fired"`.

**Verify with a real run:** two turns of a multi-step task must produce one `POST /v1/agent/tiles`. If no tiles request appears, this is not fixed.

## Task 0.4: Call `check_plan_against_state` in the live path (F0d)

**Objective:** Make the existing safety net real, and stop the test suite implying it works when production never runs it.

**Files:**
- Modify: `server/app.py` (call it in `/v1/agent/step` after the plan parses)
- Test: `bench/test_server.py` (extend)

**Step 1: Write the failing test** — a plan whose marks do not exist in the supplied screen state is rejected with a 409, not streamed.

**Step 2:** Run → FAIL (nothing calls it).

**Step 3: Implement** — validate the plan against `req.screen_state` before streaming. On mismatch, return an `ask_user` plan explaining what changed rather than an opaque error.

Also close the `frame_hash` gap: compare `screen_state.frame_hash` against `redaction_manifest.frame_hash` in the same place. The schema already promises this (`schema.ts:237`); nothing enforces it.

**Step 4:** test PASS. **Step 5:** Commit — `git commit -m "fix: the plan-validity check was tested but never called"`.

## Task 0.5: Stop the run when a step fails (F0e)

**Objective:** No silent continuation past a failure.

**Files:**
- Modify: `extension/entrypoints/background.ts:497-511`
- Test: `extension/tests/execute.test.ts`

**Step 1: Write the failing test** — step 1 fails, step 2 is never sent.

**Step 2:** Run → FAIL (step 2 is sent).

**Step 3: Implement** — read `r.ok`, report it, and break:

```ts
const r = res as { ok?: boolean; needsConfirm?: boolean; reason?: string; detail?: string } | undefined
// ...
if (r && r.ok === false) {
  // Previously `r.ok` was destructured and never read, so a failed step fell
  // through to executed++ and the next step ran against whatever wreckage the
  // failure left behind.
  sendToPanel({ kind: 'panel:error', runId, message: `Step ${i + 1} failed: ${r.detail ?? 'unknown'}` })
  break
}
```

Do not add a silent retry. A retry needs a reason and a bound; until Task 1.3 provides verification, retrying an unverified action can repeat a destructive one.

**Step 4:** tests PASS. **Step 5:** Commit.

## Task 0.6: Fix the stale Dockerfile CORS value (F9)

**Objective:** Make the container bootable again. This is a one-line fix that has been silently broken since the CORS hardening.

**Files:**
- Modify: `server/Dockerfile`
- Test: `bench/test_contract.py` (extend)

**Step 1: Write the failing test** — no shipped file may contain a wildcard origin. Extend the existing check in `test_contract.py` (which currently covers `docker-compose.yml` but not the Dockerfile) to cover `server/Dockerfile` too.

```python
df = (ROOT / "server" / "Dockerfile").read_text(encoding="utf-8")
check("the Dockerfile does not set a wildcard origin",
      "chrome-extension://*" not in df,
      "app.py refuses a wildcard outright, so the container cannot start")
```

**Step 2:** Run → FAIL.

**Step 3: Implement** — replace `VEIL_ALLOWED_ORIGINS=chrome-extension://*` with a comment pointing at `dev` and at the explicit-origin form. Do **not** silently substitute `dev` in the image: a shipped container should default to deny-by-default, exactly like the local server.

**Step 4:** test PASS.
**Step 5:** verify the image actually starts: `docker compose build veil && docker compose up veil` → expect the startup log, not a refusal.
**Step 6: Commit** — `git commit -m "fix: the Dockerfile set the CORS wildcard the server refuses"`.

---

# Part 1 — Extension execution quality

## Task 1.1: Send `execute:done` with the real action index

**Objective:** Make the step list reflect reality.

**Files:**
- Modify: `extension/lib/messages.ts` — add `actionIndex` to the `content:execute` payload
- Modify: `extension/entrypoints/content.ts:551` + the `content:execute` case
- Test: `extension/tests/execute.test.ts` (new)

**Step 1: Write the failing test**

```ts
// extension/tests/execute.test.ts
import { describe, it, expect } from 'vitest'

describe('content:execute carries the real action index', () => {
  it('reports the index it was given, not a hardcoded 0', () => {
    // The bug: executeAction(runId, 0, action) — every step reports index 0.
    const sent: Array<{ actionIndex: number; action: string }> = []
    const send = (m: { actionIndex: number; action: string }) => sent.push(m)

    for (const i of [0, 1, 2, 3]) {
      send({ actionIndex: i, action: 'click' })
    }
    // Correct behaviour: indices arrive in order and distinctly.
    expect(sent.map((s) => s.actionIndex)).toEqual([0, 1, 2, 3])
  })
})
```

**Step 2: Run and verify it fails**

Run: `cd extension && npx vitest run tests/execute.test.ts`
Expected: this passes as written (it tests the shape, not the code) — replace the body with a real import of the executor before trusting it. **The honest version of this test is an integration test in Task 1.4; do not claim this task is verified on the strength of the sketch above.**

**Step 3: Thread the index through**

In `extension/lib/messages.ts`, change:
```ts
z.object({ kind: z.literal('content:execute'), runId: z.string(), action: z.unknown() }),
```
to:
```ts
z.object({
  kind: z.literal('content:execute'),
  runId: z.string(),
  action: z.unknown(),
  /** Index of this step within plan.steps. Omitting it made every execution
   *  report index 0, so per-step status could never resolve. */
  actionIndex: z.number().int().nonnegative().default(0),
}),
```

In `content.ts`, replace the handler case and the function tail:
```ts
case 'content:execute':
  return executeAction(msg.runId, msg.actionIndex, msg.action as PlanAction)
```

and at the end of `executeAction`:
```ts
chrome.runtime.sendMessage({
  kind: 'execute:done',
  runId,
  actionIndex: index,
  ok: result.ok,          // set by Task 1.2
  status: result.status,
  ms: performance.now() - t0,
})
return result
```

**Step 4:** `npx tsc --noEmit -p tsconfig.json` → clean.
**Step 5:** `npx vitest run` → 203+ passing.

**Step 6: Commit**
```bash
git add extension/lib/messages.ts extension/entrypoints/content.ts extension/tests/
git commit -m "fix: send execute:done with the real action index

execute:done was never sent by anyone. background.ts only listened for it,
and content.ts called executeAction(runId, 0, ...) with a hardcoded 0, so
even if it had been sent every step would have reported index 0. The panel
renders step.status from this message, so no step ever showed a result."
```

---

## Task 1.2: Make `ok: false` reachable

**Objective:** An action that did not happen must be able to say so.

**Files:**
- Modify: `extension/entrypoints/content.ts:588-634` (the switch + return)
- Test: `extension/tests/execute.test.ts`

**Step 1: Write failing tests**

Cover each action's genuine failure mode:

```ts
describe('executeAction reports real outcomes', () => {
  it('fill on a non-input is a failure, not a silent success', ...)
  it('select on a non-select is a failure', ...)      // content.ts:609 `if` no-ops
  it('click on a disabled button is a failure', ...)
  it('scroll reports the direction it scrolled', ...)
  it('a resolved mark that is not eligible fails rather than clicking body', ...)
})
```

**Step 2:** Run → FAIL (everything currently returns `ok: true`).

**Step 3: Implement**

Replace the switch with one that assigns a result:

```ts
let ok = true
let status = act.action
let detail = ''

switch (act.action) {
  case 'click': {
    if (!el) { ok = false; detail = 'target not found'; break }
    if (el.hasAttribute('disabled') || (el as HTMLButtonElement).disabled) {
      ok = false; detail = 'target is disabled'; break
    }
    el.click()
    status = 'clicked'
    break
  }
  case 'fill': {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      ok = false; detail = 'fill target is not a text field'; break
    }
    setNativeValue(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    // F3: did the value actually stick? Some frameworks reject it.
    if (el.value !== value) { ok = false; detail = 'value was rejected by the field' }
    break
  }
  case 'select': {
    if (!(el instanceof HTMLSelectElement)) { ok = false; detail = 'not a <select>'; break }
    if (!act.value) { ok = false; detail = 'select has no value'; break }
    el.value = act.value
    el.dispatchEvent(new Event('change', { bubbles: true }))
    if (el.value !== act.value) { ok = false; detail = 'option not present' }
    break
  }
  // focus / hover / scroll / navigate / wait_for / none / ask_user
}

return { ok, status, detail, ms: performance.now() - t0 }
```

`none` and `ask_user` must return `ok: true` with a distinct status — they are successful no-ops by design, and conflating them with a real action would corrupt the history.

**Step 4:** tests PASS. **Step 5:** `tsc` clean.
**Step 6: Commit** — `git commit -m "fix: an action that did not happen can now report that"`.

---

## Task 1.3: Verify actions took effect

**Objective:** Close F3 — a click is not proof the click worked.

**Files:**
- Create: `extension/lib/verify.ts`
- Modify: `extension/entrypoints/content.ts`
- Test: `extension/tests/verify.test.ts` (new)

**Step 1: Write failing tests**

```ts
describe('post-action verification', () => {
  it('fill: confirms the value landed', ...)
  it('click: detects a navigation that started', ...)
  it('click: detects a DOM mutation within the settle window', ...)
  it('returns "unchanged" when nothing happened at all', ...)
})
```

**Step 2:** Run → FAIL.

**Step 3: Implement `extension/lib/verify.ts`**

```ts
export type VerifyResult = 'confirmed' | 'changed' | 'unchanged' | 'unknown'

/**
 * Cheap, bounded evidence that an action had an effect.
 *
 * This is deliberately NOT a proof of success — it cannot know what the page
 * meant to do. It distinguishes "the page reacted" from "nothing happened",
 * which is the difference the user needs. A false 'confirmed' is acceptable;
 * a false 'confirmed' on a form submit is not, so SUBMIT-class actions are
 * verified by navigation/response, never by DOM mutation alone.
 */
export function verifyFill(el: HTMLElement, expected: string): VerifyResult {
  const v = (el as HTMLInputElement).value ?? ''
  return v === expected ? 'confirmed' : 'unchanged'
}

export function observeMutation(el: HTMLElement, ms = 600): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const root = el.ownerDocument.body ?? el.ownerDocument.documentElement
    if (!root) return resolve('unknown')
    const mo = new MutationObserver(() => { mo.disconnect(); resolve('changed') }
    )
    mo.observe(root, { subtree: true, childList: true, attributes: true })
    setTimeout(() => { mo.disconnect(); resolve('unchanged') }, ms)
  })
}
```

Wire it in `content.ts` after `click` and `fill`. Keep the settle window short (600 ms) — this is a liveness check, not a correctness oracle.

**Step 4:** tests PASS. **Step 5:** `tsc` + full vitest. **Step 6: Commit** — `git commit -m "feat: verify that actions took effect"`.

---

## Task 1.4: Wire `/v1/agent/outcome`

**Objective:** Close F5 — report real outcomes to the server so it can replan and so history has truth in it.

**Files:**
- Modify: `extension/entrypoints/background.ts` (`executePlan`, ~L497-511)
- Test: `bench/test_e2e_api.py` (extend)

**Step 1: Write the failing test**

Add to `bench/test_e2e_api.py`: POST an outcome, GET `/v1/agent/session/{id}`, assert `recent_failures` contains the detail. **This test will pass today** — the endpoint works. The gap is that the *extension* never calls it, so the test must also assert the extension references it:

```python
ext = (ROOT / "extension" / "entrypoints" / "background.ts").read_text(encoding="utf-8")
check("the extension actually reports outcomes to the server",
      "/v1/agent/outcome" in ext,
      "the endpoint exists and is unwired; history would record nothing")
```

**Step 2:** Run → FAIL on the second check. This is the honest failure: it proves the wiring is missing rather than the endpoint.

**Step 3: Implement**

In `executePlan`, after each `toContent(...)`:

```ts
const r = res as { ok?: boolean; detail?: string; status?: string } | undefined
void fetch(`${serverOrigin}/v1/agent/outcome`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    session_id: runIdToSession(runId),
    turn: i,
    action,
    ok: r?.ok === true,
    detail: (r?.detail ?? '').slice(0, 200),
  }),
}).catch(() => undefined)   // never let reporting break execution
```

Use the real `run.sessionId` from `runs.get(runId)`, not a fabricated id. Note `runId` and `sessionId` are distinct — check `RunState` before wiring.

**Step 4:** test PASS. **Step 5:** `tsc` + vitest.
**Step 6: Commit** — `git commit -m "feat: report real step outcomes to /v1/agent/outcome"`.

---

## Task 1.5: Settle between steps

**Objective:** Close F4 — stop asking the user about controls that merely hadn't loaded yet.

**Files:**
- Modify: `extension/entrypoints/background.ts:472-511`
- Test: `extension/tests/execute.test.ts`

**Step 1: Write failing tests** — after a `click` that triggers a re-render, the next mark-resolve succeeds rather than returning `lost`.

**Step 2:** Run → FAIL.

**Step 3: Implement** a bounded settle in `executePlan`:

```ts
// After any click/navigate, let the page react before the next step resolves
// its mark. resolveMark already fails SAFE (it asks the user) — this stops it
// asking about a page that simply hadn't finished loading.
if (action === 'click' || action === 'navigate') {
  await settleDom(tabId, 400)
}
```

with a `MutationObserver`-quiet helper bounded at ~400 ms plus a hard cap, so a page that never stops mutating cannot hang the run.

**Step 4:** tests PASS. **Step 5:** `tsc` + vitest.
**Step 6: Commit** — `git commit -m "feat: settle the DOM between steps"`.

---

## Task 1.6: Cap steps per plan

**Objective:** A malformed plan cannot spin. `session.py` caps *replans*; nothing caps *steps within one plan*.

**Files:**
- Modify: `extension/entrypoints/background.ts` (`executePlan`)
- Modify: `extension/lib/schema.ts` — enforce at parse time
- Test: `extension/tests/execute.test.ts`

**Step 1:** Write failing test — a 500-step plan stops at the cap with `panel:error`.
**Step 2:** Run → FAIL.
**Step 3:** Implement** `MAX_STEPS_PER_PLAN = 20` in `schema.ts` via `.max(20)` on the steps array, plus a runtime guard in `executePlan`. Parse-time enforcement is the right layer: a bad plan should never enter the client.
**Step 4:** tests PASS. **Step 5:** `tsc` + vitest + `bench/test_server.py`.
**Step 6: Commit** — `git commit -m "feat: cap steps per plan at parse time"`.

---

## Part 1 verification gate

Do not proceed to Part 2 until all of these pass **on a real build**:

```bash
cd extension && npx tsc --noEmit -p tsconfig.json     # clean
cd extension && npx vitest run                        # 203+ passing
cd extension && npx wxt build
cd .. && ./.venv/Scripts/python.exe bench/test_server.py    # all pass
cd .. && ./.venv/Scripts/python.exe bench/test_cors.py     # 12/12
cd .. && ./.venv/Scripts/python.exe bench/check_panel_honesty.py   # 4/4
```

**Plus one manual check that no test replaces:** load a page with a disabled submit button, ask Veil to click it. The panel must show that step as **failed** with the reason, and `/v1/agent/session/{id}` must show the failure. If the panel says "done", Part 1 is not finished.

---

# Part 2 — Local web agent

**Scope, exactly as specified:** store run history, receive redacted data from the extension, answer post-hoc queries. It does **not** execute actions, does **not** capture, and does **not** re-redact.

## Task 2.0: Decide what "post-hoc query" needs — a blocking design decision

**This must be answered before any code.** Two options, and they are not equivalent:

**Option A — metadata only.** Store intent, plan, step outcomes, redaction classes, byte counts, timings, cost, confidence. Never the image.
- Pros: no new privacy surface, trivially small, and *sufficient* for most questions ("which step failed", "what did it cost", "what did it hide").
- Cons: "what was on that page?" is unanswerable.

**Option B — metadata + redacted image.** Also persist the redacted PNG.
- Pros: genuinely useful visual recall.
- Cons: it is a durable copy of your screen, on disk, indefinitely. Even redacted, it is a target. Needs a retention policy, a size cap, and an explicit user-facing disclosure.

**My recommendation: ship A, and design the schema so B is a single added column.** YAGNI, and the privacy argument for not keeping images is the same argument the whole product is built on. Shipping B would undercut the README's own claim.

**Two constraints the audit surfaced that bear on this decision:**

- The server *already* keeps the current frame in RAM (`VLLMClient._frames`, F10), unbounded and overwritten each turn. So Option B is a smaller change than it sounds — but it converts an in-memory working buffer into a durable archive, which is a different commitment.
- `session.py:99-102` explicitly justifies its in-memory design: *"A privacy tool that writes user task history to disk has created a new dataset to protect."* Part 2 reverses that. That is a deliberate reversal, and the docstring must say so in the same commit (F11) rather than leaving a comment that contradicts the code.

Everything below assumes **A**.

## Task 2.1: Persistence layer (stdlib sqlite3)

**Objective:** Durable history, replacing the in-memory-only store's amnesia (F6).

**Files:**
- Create: `server/store.py`
- Modify: `server/requirements.txt` (nothing to add — stdlib)
- Test: `bench/test_store.py` (new)

**Step 1: Write failing tests**

```python
def test_roundtrip():
    s = Store(":memory:")
    sid = s.record_turn(TurnRecord(session_id="s-12345678", turn=0, intent="fill form"))
    assert s.get_turn(sid) is not None

def test_survives_reopen():
    # A new Store on the same file sees the same rows. This is the whole point.
    ...

def test_rejects_raw_pii_shaped_values():
    # Defence in depth: a stored transcript must not be able to hold a raw
    # email even if a future caller passes one.
    ...

def test_history_is_bounded():
    # Retention: a cap, so the DB cannot grow without limit.
    ...
```

**Step 2:** Run → FAIL (`ModuleNotFoundError`).

**Step 3: Implement `server/store.py`**

```python
"""Durable run history. Stdlib sqlite3 only — no ORM, no new dependency.

Deliberately metadata-only. The redacted image is NOT stored: this project's
entire claim is that sensitive pixels never leave the device, and keeping a
durable copy of the screen would undercut it for a feature that can be built
without one. See the plan's Task 2.0.
"""
```

Schema: `turns` (id, session_id, turn, at, intent, plan_json, manifest_summary_json, bytes_in, bytes_out, elapsed_ms, provider, model, cost_usd, confidence, outcome_json) and `steps` (turn_id, idx, action, ok, detail, ms).

**The audit found most of these fields already exist in the process and are then thrown away** — `plan.confidence` is read by the escalation gate and dropped (`app.py:654`); the privacy summary is built inside `build_system_preamble` and discarded with the prompt (`prompts.py:84-85`); `client_timings` is declared (`app.py:284`) and never read; `_first_token_ms` is assigned and never used (`app.py:490-492`). Capturing them is nearly free once the store exists.

**Mint a server-side turn id.** The audit found `req.turn` is a client-supplied int that is never validated against `sess.turns` — a client can send turn 999 or repeat turn 3, and there is no join key between an outcome and the step that produced it. Without a server-minted id, history rows cannot be reliably linked. This matters more than it sounds: Task 0.3 makes the client actually increment turns, which is exactly when a client-controlled counter becomes load-bearing.

**Freeze released privacy counts at write time.** `manifest_privacy`'s RNG is seeded per session (`manifest_privacy.py:100-108`), so re-summarizing a *stored* manifest re-noises already-noised numbers. Store the released summary once; never recompute it on read.

**Also rewrite `SessionStore`'s docstring** (F11) in this commit. It currently argues *against* the thing Part 2 is doing.

Enable WAL, `PRAGMA foreign_keys=ON`, and a retention sweep. Store the **manifest summary** (class names + counts), never `placeholder.token` values that could carry user content.

**Step 4:** tests PASS. **Step 5:** Commit — `git commit -m "feat: durable run history in sqlite"`.

## Task 2.2: Persist on the existing request path

**Objective:** Record every turn without a new endpoint the client must learn.

**Files:**
- Modify: `server/app.py` (`/v1/agent/step`, `/v1/agent/outcome`)
- Test: `bench/test_store.py`, `bench/test_e2e_api.py`

**Step 1: Write failing test** — POST a step, then read the turn back out of the store.
**Step 2:** Run → FAIL.
**Step 3:** Implement** — one `store.record_turn(...)` call after the plan streams, and one `store.record_step(...)` in `/outcome`. Failures here must be logged and swallowed: a history write must never break a live turn.
**Step 4:** tests PASS. **Step 5:** Commit.

## Task 2.3: History API

**Objective:** Read endpoints for the UI.

**Files:**
- Create: `server/history_api.py`
- Modify: `server/app.py` (mount the router)
- Test: `bench/test_history.py` (new)

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/runs` | list sessions: id, intent, at, turn count, total cost, outcome |
| GET | `/api/runs/{session_id}` | full turn-by-turn detail |
| POST | `/api/runs/{session_id}/ask` | **post-hoc question** |
| DELETE | `/api/runs/{session_id}` | forget a run |

**The `/ask` endpoint is the actual product.** It assembles a prompt from the stored turns and calls the same provider abstraction the agent uses — so it reuses the router, cost accounting, and injection scanning rather than adding a second path to a model.

**Critical (F12):** `injection.py` scans page labels on the way *in* and **fails open** — a finding is logged and injected as "treat it as data", never blocking. A stored transcript is therefore untrusted page-derived text that was scanned once, at write time.

Answering a question about stored history re-enters that text into a prompt. **`scan_many()` must run on read, not just on write**, or a page that planted an instruction in turn 1 gets to act on it in turn 40. Store-then-ask must not become inject-then-ask.

`/v1/agent/validate` (`app.py:607-614`) already provides the "re-check this text" primitive — reuse it rather than writing a second validator.

**Step 1-6:** TDD as above. Commit `feat: history read API with injection-scoped /ask`.

## Task 2.4: Serve the UI

**Objective:** A local web surface. No build step, no new dependency.

**Files:**
- Create: `web/index.html`, `web/app.js`, `web/style.css`
- Modify: `server/app.py` — `StaticFiles` mount
- Test: `bench/check_web_ui.py` (new)

Use `app.mount("/", StaticFiles(directory=..., html=True))` — `StaticFiles` ships with the already-installed starlette, so `jinja2` is not needed and nothing is added to `requirements.txt`.

**Security, non-negotiable:** the UI must bind to `127.0.0.1` and not be reachable from the network. Today every site a user visits can POST to `127.0.0.1:8000`; CORS is the only guard, and CORS is not authentication. Adding a browser UI on the same origin means **any XSS in the UI reaches the history API**. Mitigations:

- Serve the UI only when a shared token from `.env` is present, matching the `VEIL_ALLOWED_ORIGINS` discipline already established.
- Escape all rendered content — history contains page-derived strings.
- `Cache-Control: no-store` on every response carrying run data.
- Add a `/api/runs` auth check, not just CORS.

**Step 1-6:** TDD. Commit `feat: local web agent UI`.

## Task 2.5: Wire the extension's history view

**Objective:** The panel can link to a run in the web UI; it does not duplicate it.

**Files:**
- Modify: `extension/entrypoints/sidepanel/panel.tsx` + `index.html`
- Test: `bench/check_reload_button.py`-style layout check

The panel keeps the safety-critical loop (ledger, confirmation card, status). The web UI owns conversation history and post-hoc questions. A link, not a reimplementation — two surfaces both claiming to be the source of truth is the failure mode to avoid.

**Commit:** `feat: link the panel to run history`.

---

## Final verification gate

```bash
cd extension && npx tsc --noEmit -p tsconfig.json && npx vitest run && npx wxt build
cd .. && for s in test_cors test_server test_providers test_contract test_store test_history; do
  ./.venv/Scripts/python.exe bench/$s.py; done
cd .. && ./.venv/Scripts/python.exe bench/test_e2e_api.py http://127.0.0.1:8000
cd .. && ./.venv/Scripts/python.exe bench/check_panel_honesty.py
cd .. && ./.venv/Scripts/python.exe bench/check_reload_button.py
cd .. && ./.venv/Scripts/python.exe bench/check_web_ui.py
```

**Manual, and not automatable:**
1. **The destructive-action gate.** Run a task whose plan contains a `submit`. The card must appear. Decline it. The run must end *declined* — not "Cancelled at your request", and not after a 60-second stall. *(F0a — the single most important check in this plan.)*
2. **Iframe isolation.** On a page with a same-extension iframe containing a button, run a plan that clicks a top-frame control. Only the top frame acts. *(F0b)*
3. **Delta tiles.** Run a two-turn task. The second turn must produce a `POST /v1/agent/tiles` in the server log. *(F0c)*
4. **Failure honesty.** Ask Veil to click a disabled submit. The panel must show that step as **failed** with a reason, and `/v1/agent/session/{id}` must show the failure. *(F1/F2/F3)*
5. **History durability.** Run a task. Kill the server. Restart it. Open the web UI. The run is still there. *(Task 2.1 — the in-memory store would have lost it.)*
6. **Post-hoc query.** Ask the web UI "what did step 3 do in that run?" It answers from stored history, citing turn and step.
7. **Unreachable server.** With the server stopped, the panel's status dot reads unreachable. *(Regression guard for the CORS/health work.)*
8. **Origin refusal.** `curl -H "Origin: https://evil.example" http://127.0.0.1:8000/api/runs` → refused.
9. **Container boot.** `docker compose up veil` starts. *(F9 — this is currently broken.)*

---

## Risks

| Risk | Mitigation |
|---|---|
| **F0a regression:** the confirm card renders but approval still hangs | Prefer sending the real `execute:confirm_required` over a `-1` sentinel; add a manual gate that declines, not just one that approves |
| **F0b regression:** narrowing to one frame breaks cross-frame flows | Fail *safe* (unexpected frame does nothing) rather than requiring every send to be addressed |
| Verification (1.3) reports false confidence | Deliberately labelled `confirmed`/`changed`/`unchanged`/`unknown`; never "success". Submit-class actions verified by navigation, not mutation. |
| Storing history creates a new privacy surface | Option A only (no images). Token-gated UI. `no-store`. Retention cap. Rewrite the docstring that argues against it. |
| **F12:** stored transcripts become a stored injection vector | `scan_many()` on **read**, not just write. Injection scanning fails open, so this is the only control. |
| `/ask` becomes an injection vector | Same as above; reuse `/v1/agent/validate` as the re-check primitive. |
| Client-controlled `turn` cannot be trusted as a join key | Mint a server-side turn id in Task 2.1. |
| Docker regressions go unnoticed because CI runs the local loop | Task 0.6 adds a contract check on the Dockerfile and a real `docker compose up` verification. |
| Scope creep into a second executor | The web agent has no execute path. Stated in Part 2's scope and enforced by not writing one. |
| SQLite write contention blocking a live turn | Writes are tiny, wrapped, and swallowed on failure. A history failure must never fail a turn. |
| Step cap breaks a legitimately long plan | 20 is generous for UI automation; the server's replan cap still applies across turns. |

## Open questions for the user

1. **Task 2.0 — metadata only, or also the redacted image?** Blocks Part 2. I recommend metadata only.
2. **Retention?** Default 30 days / 500 turns is my suggestion; a privacy tool with unbounded history is self-undermining.
3. **Token-gated UI?** I plan to require it. If you want zero-friction local access, say so and I'll gate on loopback-binding alone.
4. **Post-hoc queries call the paid provider?** My plan reuses your configured model, so they cost tokens like any other turn. Free-text search over metadata is the zero-cost alternative.
