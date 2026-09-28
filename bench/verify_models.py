#!/usr/bin/env python3
"""Verify every model id cited in the codebase actually exists.

Why this file exists: two model ids in an earlier revision were written from
memory and did not exist on the Hub. The failure was silent — the session threw,
the cascade returned "unavailable", and the extension quietly ran L0/L1 forever
while the README implied a four-layer detector. A privacy product that silently
degrades its own detection is worse than one that crashes.

HuggingFace answers 401 (not 404) for repos that do not exist, to avoid leaking
private repo names. So 401 is the failure signal here.

    python bench/verify_models.py          # check ids
    python bench/verify_models.py --sizes  # also report q8 weight sizes
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS_TS = ROOT / "extension" / "entrypoints" / "offscreen" / "models.ts"
UA = {"User-Agent": "veil-verify/1.0"}


def get(url: str, timeout: int = 30) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception:  # noqa: BLE001
        return 0, b""


def repo_exists(repo: str) -> bool:
    status, body = get(f"https://huggingface.co/{repo}/resolve/main/config.json")
    if status == 200:
        return True
    # Some repos have no config.json at root; try the API before concluding.
    status, body = get(f"https://huggingface.co/api/models/{repo}")
    return status == 200


def q8_size(repo: str) -> int | None:
    """Size in bytes of the q8/quantized ONNX weight, preferring the smallest
    quantized variant available."""
    status, body = get(f"https://huggingface.co/api/models/{repo}")
    if status != 200:
        return None
    try:
        files = [s["rfilename"] for s in json.loads(body).get("siblings", [])]
    except Exception:  # noqa: BLE001
        return None
    cands = [
        f for f in files
        if f.endswith(".onnx") and any(k in f.lower() for k in ("quantized", "_int8", "_uint8", "_q4"))
    ]
    if not cands:
        cands = [f for f in files if f.endswith(".onnx")]
    best: int | None = None
    for f in cands:
        st, _ = get(f"https://huggingface.co/{repo}/resolve/main/{f}", timeout=30)
        if st != 200:
            continue
        try:
            req = urllib.request.Request(
                f"https://huggingface.co/{repo}/resolve/main/{f}", headers=UA, method="HEAD"
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                n = int(r.headers.get("Content-Length", 0))
        except Exception:  # noqa: BLE001
            continue
        if n and (best is None or n < best):
            best = n
    return best


def ids_in_source() -> list[str]:
    src = MODELS_TS.read_text(encoding="utf-8")
    block = re.search(r"MODEL_IDS\s*=\s*\{(.*?)\}\s*as const", src, re.S)
    if not block:
        return []
    return re.findall(r"'([^']+)'", block.group(1))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", action="store_true", help="also fetch quantized weight sizes")
    args = ap.parse_args()

    repos = ids_in_source()
    if not repos:
        print(f"ERROR: no MODEL_IDS block found in {MODELS_TS}", file=sys.stderr)
        return 2

    print(f"\n  VEIL — MODEL ID VERIFICATION ({len(repos)} ids from {MODELS_TS.name})\n")
    print("  " + "-" * 74)
    ok = True
    for repo in sorted(set(repos)):
        exists = repo_exists(repo)
        line = f"  {'OK  ' if exists else 'MISS'}  {repo}"
        if exists and args.sizes:
            n = q8_size(repo)
            line += f"   q8: {n / 1048576:>7.1f} MB" if n else "   q8: (no onnx weights found)"
        print(line)
        if not exists:
            ok = False
    print("  " + "-" * 74)
    if ok:
        print("  all model ids resolve on the Hub\n")
        return 0
    print("  FAIL: at least one model id does not exist. A session for it will\n"
          "  throw, the cascade will degrade a layer, and it will do so SILENTLY.\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
