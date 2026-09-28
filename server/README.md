# Veil server

A privacy-preserving proxy between the extension and any vision-capable LLM.

The client does the privacy work. The server's job is to turn a **redacted**
page into a **validated** plan, and to never weaken either property on the way.

## Configure it

```bash
cp .env.example .env      # then fill in
```

```bash
VEIL_LLM_PROVIDER=openai
VEIL_LLM_BASE_URL=https://api.openai.com/v1
VEIL_LLM_API_KEY=sk-...
VEIL_LLM_MODEL=gpt-6-luna
```

That is the whole requirement. Any endpoint that speaks
`POST {base}/chat/completions` with an `image_url` content part works —
OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, vLLM, or your own.

`VEIL_LLM_API_KEY` may be **empty** for a local endpoint. Requiring a fake key
would push people toward putting a placeholder secret in `.env`, which is the
habit this project exists to break.

### Run it

```bash
docker compose up                    # server + local vLLM
# or, against your own endpoint:
docker compose up veil               # no vLLM needed
```

## Before you trust it: check grounding

**This is the one thing to do first.** A frontier vision model is trained to
*describe* pages, not to *index* elements. It may be far more capable than a
small local VLM and still be unable to reliably say "click the element
numbered 7" — which is the only thing Veil asks it to do.

```bash
./.venv/Scripts/python.exe bench/measure_grounding.py --turns 8
```

It reports schema validity, whether marks are used, whether any mark was
**invented**, latency, and cost per turn. Then read the verdict. A model that
describes but does not target is not a planner, however good it looks.

No API key? It says so and exits non-zero rather than reporting a fake 0%.

To check the endpoint itself first — model id, whether it can actually read an
image, and whether it supports strict schema:

```bash
./.venv/Scripts/python.exe bench/probe_endpoint.py --model <id> --api-key <key>
```

## Measured model results

Featherless, 6 Veil planner turns each, 8192-token ceiling, 2026-09-29.
Reproduce with `bench/compare_models.py`.

| model | valid | used a mark | invented | p50 | p95 | $/turn |
|---|---|---|---|---|---|---|
| `Qwen/Qwen3-VL-8B-Instruct` | 6/6 | 6/6 | **0** | **6271 ms** | 14388 ms | $0.000297 |
| `Qwen/Qwen3-VL-30B-A3B-Instruct` | 6/6 | 6/6 | **0** | 11159 ms | 22194 ms | $0.000288 |
| `Qwen/Qwen3-VL-32B-Instruct` | 6/6 | 6/6 | **0** | 15674 ms | 24763 ms | $0.000296 |
| `Qwen/Qwen3-VL-235B-A22B-Thinking` | — | — | — | provider busy | — | — |

Three findings that are not obvious:

1. **The 8B is the fastest**, 2.5× quicker than the 32B. On a shared endpoint,
   throughput beats parameter count.
2. **All three emit ~450 output tokens per plan regardless of size.** Plan
   *length* is set by the schema, not by capability, so a bigger model is not
   automatically more thorough here. This is why the tooling ranks on grounding
   first and treats length as uninformative.
3. **235B-A22B-Thinking is the strongest on paper and was unavailable on both
   attempts** — HTTP 400, *"This model is busy"*. That is capacity, not
   capability. If your credits allow it, it is the one worth retrying.

`max_tokens` is a **ceiling, not a reservation** — you pay only for tokens
actually generated, so a high cap costs nothing unless the model uses it. The
default is 8192, which clears any plan the 12-step schema allows. The old 512
was not a safety limit, it was a leftover, and it truncated plans mid-JSON —
which reaches the client as an *unparseable* plan rather than a short one.

## Provider capabilities are declared, not assumed

Providers do not make the same promises, and the difference is a privacy
property, not a preference. Every provider declares what it can actually do:

| field | meaning |
|---|---|
| `schema_enforcement` | `strict` (token-level), `requested` (honoured, not guaranteed), `none` |
| `vision` | can it see the redacted frame |
| `zdr_eligible` | **you** declare this; the server never infers it |
| `max_image_bytes` | refuse an oversized image with a clear error |
| `grounded_marks` | set by measurement, never by hope |
| `usd_per_mtok_in/out` | unset means UNKNOWN, never `0.0` |

`GET /health` returns all of it. When enforcement is not `strict`, the server
tells the model to be careful *and* the client validates harder.

`VEIL_LLM_MODE` picks the guarantee. If your endpoint rejects the `strict` key
with a 400, set `json` — the downgrade is visible in `/health`, not silent.

## Routes

| route | purpose |
|---|---|
| `GET /health` | liveness + every provider's declared capabilities |
| `POST /v1/agent/step` | SSE stream of the ActionPlan |
| `POST /v1/agent/tiles` | delta-tile re-compositing |
| `POST /v1/agent/outcome` | client reports what a step actually did |
| `GET /v1/agent/session/{id}` | per-session cost, attempts, failures |
| `POST /v1/agent/validate` | validate a plan standalone |

## The loop is bounded

A step that fails, replans, and fails again is an agent that will spin. The
cap is what makes retrying safe at all:

```
3 failed attempts  ->  ask_user("stopping after 3 attempts…")
```

The cap is checked **before** planning and again on the arriving plan, so it
holds whichever path a turn takes. Reaching it hands control back rather than
trying again.

## Declines are remembered

If the user says no to an action, it goes into session memory and the next
preamble says so explicitly. An agent that re-proposes a declined step is an
agent that nags.

## Prompt-injection detection

Pages are untrusted input. The preamble already treats page text as data; this
adds detection of text *shaped like instructions* to an agent
(`server/injection.py`).

It is a heuristic and says so. The patterns catch common shapes and will not
catch a paraphrase. The value is not completeness — it is that an attack
becomes **visible in the log** instead of silent.

Note what this is and is not. In Veil, injection cannot exfiltrate credentials,
because sensitive values are already redacted client-side. What it can cause is
an unwanted *action*. That is what the detection is aimed at.

## Manifest privacy

The manifest tells the server what was hidden — but by default it also says
**how many** of each class. On a banking page, "exactly 3 Aadhaar numbers"
is itself sensitive.

```bash
VEIL_MANIFEST_PRIVACY=exact      # counts as-is (default)
VEIL_MANIFEST_PRIVACY=bucketed   # power-of-two: 1, 2-3, 4-7
VEIL_MANIFEST_PRIVACY=noise      # Laplace noise, epsilon in VEIL_MANIFEST_EPSILON
```

`bucketed` is **coarsening, not formal differential privacy**, and the code says
so. `noise` is the mode that offers a real epsilon guarantee, and the weakest
for utility at small counts. Noise is seeded per session, because re-noising on
every retry would let an observer average the releases and recover the true
count.

## Cost

The screenshot is ~74% of input tokens, so it dominates the bill. The server
estimates and logs per-session cost. **Unset pricing reports UNKNOWN, never
`0.0`** — an unpriced provider is not a free one.

Prices current as of 2026-09-28:

| model | in / out per 1M |
|---|---|
| GPT-6 Luna | 0.10 / 0.50 |
| GPT-6 Sol | 2.00 / 10.00 |
| GPT-6 Astra | 10.00 / 50.00 |
| Gemini 3.8 Flash | 0.75 / 1.50 |

## Tests

```bash
./.venv/Scripts/python.exe bench/test_providers.py    # 79 checks, no key needed
./.venv/Scripts/python.exe bench/test_server.py       # 16 checks
./.venv/Scripts/python.exe bench/test_cors.py         #  9 checks
./.venv/Scripts/python.exe bench/test_contract.py    #  5 checks
```

The provider suite needs no API key and no network: it uses a scripted fake, so
a test suite that needs a paid API is a suite that stops being run.

Full chain, against a mock endpoint:

```bash
./.venv/Scripts/python.exe bench/mock_llm_server.py --port 8100 &
VEIL_LLM_PROVIDER=openai VEIL_LLM_BASE_URL=http://127.0.0.1:8100 \
VEIL_LLM_API_KEY=x VEIL_LLM_MODEL=mock-vision \
  ./.venv/Scripts/python.exe -m uvicorn server.app:app --port 8010 &
./.venv/Scripts/python.exe bench/test_e2e_api.py http://127.0.0.1:8010
```

The mock can rehearse failures: `--behaviour nomark|invent|loose`.
