"""
Probe an OpenAI-compatible endpoint for the three things Veil actually needs.

Run this against Featherless (or anything else) before you wire it up. It answers:

  1. Does /v1/models respond, and is the model id EXACTLY right?  A model id
     that resolves on the catalog page can still 404 on inference, and the
     difference is usually an `-it` suffix or a quantisation tag.
  2. Does the endpoint accept an IMAGE, and does the model actually SEE it?
     A 200 on an image request proves nothing if the model replies about
     nothing. So the image contains a token in large type and we ask for it
     back. A model that cannot read it says so, which is the answer you need
     before wiring it as a planner.
  3. Does `response_format: json_schema` with `strict: true` work, or does it
     400? This decides VEIL_LLM_MODE. Featherless proxies many backends and
     they do not all implement strict decoding, and finding out from a 400 at
     2am is worse than finding out now.

    ./.venv/Scripts/python.exe bench/probe_endpoint.py \\
        --base-url https://api.featherless.ai/v1 \\
        --model Qwen/Qwen3-VL-8B-Instruct \\
        --api-key $FEATHERLESS_API_KEY
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys

try:
    import httpx
except ImportError:
    print("  needs httpx: pip install httpx", file=sys.stderr)
    raise SystemExit(2)


def make_probe_image(text: str) -> str:
    """A PNG with `text` drawn as REAL GLYPHS, so a vision model can read it.

    The first version of this drew one filled RECTANGLE per character. The model
    replied `'||||||'` — which was a correct description of six vertical bars,
    not a reading failure. A probe that cannot tell "cannot see the image" from
    "can see the image but it contains no letters" is not a vision test, so it
    draws actual letterforms now.

    Uses PIL's default bitmap font rather than a TrueType file so there is no
    font dependency and the output is identical on every machine.
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        # No Pillow: return a 1x1 image. The model will say it cannot read it,
        # which is a truthful result rather than a crash — and it is reported
        # as a WARN, never as a pass.
        return (
            "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoz2P8//8/AzWBiYGa"
            "YNKBzMK4wcMBAAgAAQEBvA0nAAAAAElFTkSuQmCC"
        )

    # PIL's default font is ~11px, which is genuinely too small: a human
    # reading the same PNG reported "W0.7" instead of "VEIL7". A vision model
    # would fail the same way, and the probe would wrongly conclude the model
    # cannot see. So: find a real TrueType face and draw at a real size.
    #
    # Falls back through the faces Windows ships, then to the bitmap font, and
    # finally to blocks — and says which it used, because "the probe drew bars"
    # and "the model cannot see" must never look the same.
    font = None
    for cand in (
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\consola.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ):
        try:
            from PIL import ImageFont

            font = ImageFont.truetype(cand, 84)
            drew = cand
            break
        except Exception:  # noqa: BLE001
            continue

    img = Image.new("RGB", (900, 300), "white")
    d = ImageDraw.Draw(img)
    if font is not None:
        d.text((70, 100), text.upper(), fill="black", font=font)
    else:
        # Blocks. This is NOT a valid vision test and the caller reports it as
        # such rather than blaming the model.
        for i, _ch in enumerate(text.upper()):
            x = 70 + i * 110
            d.rectangle([x, 80, x + 84, 200], fill="black")
    d.rectangle([12, 12, 888, 288], outline="black", width=4)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    globals()["_DREW"] = drew if font is not None else "blocks"
    return base64.b64encode(buf.getvalue()).decode()


def probe(base: str, model: str, key: str, token: str, timeout: float) -> int:
    headers = {"content-type": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"

    ok = True
    print("=" * 72)
    print(f"  ENDPOINT PROBE — {base}  model={model}")
    print("=" * 72)

    with httpx.Client(timeout=timeout) as c:
        # 1. model id
        print("\n  1. model id")
        try:
            r = c.get(f"{base}/models", headers=headers)
            if r.status_code != 200:
                print(f"     FAIL  /models -> {r.status_code}  {r.text[:120]}")
                ok = False
            else:
                ids = [m.get("id") for m in r.json().get("data", [])]
                hit = model in ids
                print(f"     {'OK  ' if hit else 'FAIL'}  {len(ids)} models listed; "
                      f"exact id present: {hit}")
                if not hit:
                    near = [i for i in ids if model.split("/")[-1][:14].lower() in i.lower()][:5]
                    print(f"     did you mean: {near}")
                    ok = False
        except Exception as e:  # noqa: BLE001
            print(f"     FAIL  {type(e).__name__}: {e}")
            return 1

        b64 = make_probe_image(token)
        content = [
            {"type": "text", "text": f"Read the characters in this image. Reply with only them."},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"}},
        ]

        # 2. vision
        print("\n  2. vision (does it see the image?)")
        try:
            r = c.post(
                f"{base}/chat/completions",
                headers=headers,
                json={"model": model, "messages": [{"role": "user", "content": content}],
                      "max_tokens": 64, "temperature": 0},
            )
            if r.status_code != 200:
                print(f"     FAIL  {r.status_code}  {r.text[:200]}")
                print("     -> this endpoint rejected the image. It is not usable as a planner.")
                ok = False
            else:
                txt = (r.json()["choices"][0]["message"].get("content") or "").strip()
                saw = token.upper() in txt.upper().replace(" ", "")
                print(f"     {'OK  ' if saw else 'WARN'}  model said: {txt[:70]!r}")
                if not saw:
                    print("     -> the model answered but did not read the image.")
                    print("        It may not be vision-capable, or vision may be disabled.")
                    ok = False
        except Exception as e:  # noqa: BLE001
            print(f"     FAIL  {type(e).__name__}: {e}")
            ok = False

        # 3. strict schema
        print("\n  3. strict json_schema (decides VEIL_LLM_MODE)")
        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["session_id", "steps", "confidence"],
            "properties": {
                "session_id": {"type": "string"},
                "confidence": {"type": "number"},
                "steps": {
                    "type": "array", "minItems": 1, "maxItems": 3,
                    "items": {
                        "type": "object", "additionalProperties": False,
                        "required": ["action"],
                        "properties": {
                            "action": {"type": "string",
                                       "enum": ["click", "fill", "none", "ask_user"]},
                        },
                    },
                },
            },
        }
        try:
            r = c.post(
                f"{base}/chat/completions",
                headers=headers,
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "Reply with a valid plan for a blank page."}],
                    "max_tokens": 256, "temperature": 0,
                    "response_format": {"type": "json_schema",
                                        "json_schema": {"name": "action_plan", "strict": True,
                                                        "schema": schema}},
                },
            )
            if r.status_code == 200:
                body = r.json()
                txt = body["choices"][0]["message"].get("content") or ""
                try:
                    parsed = json.loads(txt)
                    good = isinstance(parsed.get("steps"), list) and "session_id" in parsed
                    print(f"     {'OK  ' if good else 'WARN'}  schema-valid plan returned")
                    print(f"     -> VEIL_LLM_MODE=strict")
                    if not good:
                        ok = False
                except json.JSONDecodeError as e:
                    print(f"     WARN  accepted json_schema but returned invalid JSON: {e}")
                    print(f"     raw: {txt[:100]!r}")
                    print(f"     -> VEIL_LLM_MODE=json  (validator becomes the only gate)")
            else:
                low = r.text.lower()
                if "json_schema" in low or "response_format" in low or "unsupported" in low:
                    print(f"     FAIL  {r.status_code} — this endpoint does not support strict json_schema")
                    print(f"     -> VEIL_LLM_MODE=json")
                else:
                    print(f"     FAIL  {r.status_code}  {r.text[:160]}")
                    print(f"     -> try VEIL_LLM_MODE=json")
        except Exception as e:  # noqa: BLE001
            print(f"     FAIL  {type(e).__name__}: {e}")

    print("\n" + "=" * 72)
    if ok:
        print("  READY. Configuration:")
        print(f"    VEIL_LLM_BASE_URL={base}")
        print(f"    VEIL_LLM_MODEL={model}")
        print(f"    VEIL_LLM_MODE=strict")
        print("  Now run:  bench/measure_grounding.py --turns 8")
    else:
        print("  NOT READY — see the FAIL lines above.")
    print("=" * 72)
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=os.environ.get("VEIL_LLM_BASE_URL", "https://api.featherless.ai/v1"))
    ap.add_argument("--model", default=os.environ.get("VEIL_LLM_MODEL", ""))
    ap.add_argument("--api-key", default=os.environ.get("VEIL_LLM_API_KEY", ""))
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--token", default="VEIL7")
    a = ap.parse_args()

    if not a.model:
        print("  --model is required (or set VEIL_LLM_MODEL)", file=sys.stderr)
        return 2
    return probe(a.base_url.rstrip("/"), a.model, a.api_key, a.token, a.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
