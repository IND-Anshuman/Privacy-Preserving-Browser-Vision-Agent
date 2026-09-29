"""
Deployment contract: the container's configuration must be one the server accepts.

`server/Dockerfile` baked in `VEIL_ALLOWED_ORIGINS=chrome-extension://*`. The
server now REFUSES a wildcard — it raises SystemExit(2) at import — so the
image could not start. It went unnoticed for two reasons: every local test
imports the app in-process and never builds the image, and docker-compose
happened to override the variable with `dev`, so `docker compose up` worked
while a bare `docker run` of the image died.

That second reason is the dangerous part: the value was dead, not absent, and
only a second code path was hiding it. These checks make the mismatch a test
failure instead of a boot failure discovered by a judge.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PASS, FAIL = 0, 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"  -- {detail}" if detail else ""))


def env_assignments(text: str) -> dict[str, str]:
    """Parse `KEY=value` out of Dockerfile ENV lines (continuations included)."""
    out: dict[str, str] = {}
    # Join backslash continuations first so a multi-line ENV reads as one.
    joined = re.sub(r"\\\s*\n\s*", " ", text)
    for m in re.finditer(r"^\s*ENV\s+(.*)$", joined, re.M | re.I):
        for pair in re.finditer(r"([A-Z_][A-Z0-9_]*)=(\S+)", m.group(1)):
            out[pair.group(1)] = pair.group(2)
    return out


def main() -> int:
    print("== deployment contract ==")
    df_path = ROOT / "server" / "Dockerfile"
    check("server/Dockerfile exists", df_path.exists())
    if not df_path.exists():
        print(f"\n{PASS}/{PASS + FAIL} passed")
        return 1

    text = df_path.read_text(encoding="utf-8")
    envs = env_assignments(text)

    # 1. The specific regression: a wildcard CORS value in the image.
    cors = envs.get("VEIL_ALLOWED_ORIGINS")
    check(
        "the image does not bake in a wildcard CORS origin",
        cors is None or cors.strip() not in {"*", "null"},
        f"VEIL_ALLOWED_ORIGINS={cors!r} would make the server SystemExit(2)",
    )
    # Only an ENV ASSIGNMENT matters. The literal also appears in the
    # explanatory comment that documents the old breakage, and flagging a
    # comment would train people to delete the explanation of the bug.
    assigned_literal = any(
        "chrome-extension://*" in v for v in envs.values()
    )
    check(
        "no ENV line assigns the chrome-extension://* wildcard",
        not assigned_literal,
        f"ENV values: {envs}",
    )

    # 2. No credential baked into an image layer. Keys belong to the
    #    environment; an ENV here would ship in `docker history`.
    secret_keys = [k for k in envs if re.search(r"API_KEY|SECRET|TOKEN|PASSWORD", k)]
    check(
        "no credential is baked into the image",
        not secret_keys,
        f"found {secret_keys}",
    )

    # 3. compose must not reintroduce a wildcard either.
    compose_path = ROOT / "docker-compose.yml"
    if compose_path.exists():
        comp = compose_path.read_text(encoding="utf-8")
        bad = re.findall(r"VEIL_ALLOWED_ORIGINS:\s*\$\{[^}]*:-([^}]+)\}", comp)
        check(
            "compose does not default VEIL_ALLOWED_ORIGINS to a wildcard",
            all(b.strip() not in {"*", "null"} for b in bad),
            f"compose defaults: {bad}",
        )

    # 4. The server's refusal is real, not aspirational. Prove the wildcard
    #    actually aborts, so check 1 is anchored to observed behaviour.
    sys.path.insert(0, str(ROOT))
    import os
    import subprocess

    probe = subprocess.run(
        [sys.executable, "-c",
         "import os; os.environ['VEIL_ALLOWED_ORIGINS']='*';"
         "import server.app"],
        cwd=str(ROOT), capture_output=True, text=True,
    )
    check(
        "a wildcard origin really does abort the server",
        probe.returncode != 0,
        f"returncode={probe.returncode}; the Dockerfile check would be vacuous",
    )

    print(f"\n{PASS}/{PASS + FAIL} passed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
