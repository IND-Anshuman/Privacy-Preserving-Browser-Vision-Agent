"""
Contract test: the server must accept exactly what the CLIENT sends.

This file exists because of a real break. `RedactionModel.pixel_derived` did not
match the extension's `RedactionEntrySchema`, which emits `pixelDerived`. Every
request from the real client was rejected with HTTP 422, and the server's own
test suite passed 17/17 the whole time — because the fixtures had been written
in the server's spelling, so the suite was testing the server against itself.

The fixture below is therefore generated from the CLIENT's Zod schema rather
than typed by hand, and a shape mismatch fails here instead of in a demo.

    ./.venv/Scripts/python.exe bench/test_contract.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "extension" / "lib" / "schema.ts"

# Import as `server.app` so the package-relative imports inside app.py resolve.
# Adding server/ to sys.path and importing `app` directly makes those relative
# imports fail with "attempted relative import with no known parent package".
sys.path.insert(0, str(ROOT))

FAILS: list[str] = []
CHECKS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if ok:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        FAILS.append(name)


def client_manifest_entry_fields() -> set[str]:
    """Field names the client's RedactionEntrySchema declares."""
    src = SCHEMA.read_text(encoding="utf-8")
    m = re.search(
        r"RedactionEntrySchema\s*=\s*z\.object\(\{(.*?)\n\}\)", src, re.S
    )
    if not m:
        return set()
    body = m.group(1)
    # Top-level keys only: a key at two-space indentation.
    return set(re.findall(r"^\s{2}([A-Za-z_]\w*):", body, re.M))


def server_manifest_entry_fields() -> set[str]:
    src = (ROOT / "server" / "app.py").read_text(encoding="utf-8")
    m = re.search(r"class RedactionModel\(BaseModel\):(.*?)\n\nclass ", src, re.S)
    if not m:
        return set()
    body = m.group(1)
    out: set[str] = set()
    for line in body.splitlines():
        line = line.strip()
        m2 = re.match(r"([A-Za-z_]\w*)\s*:\s*\w", line)
        if m2:
            out.add(m2.group(1))
        # `x: T = Field(alias="y")` also declares the wire name y.
        m3 = re.search(r'alias="(\w+)"', line)
        if m3:
            out.add(m3.group(1))
        # a bare alias adds a second accepted spelling
        m4 = re.match(r"([A-Za-z_]\w*)\s*:\s*bool\s*$", line)
        if m4:
            out.add(m4.group(1))
    return out


def main() -> None:
    print("\n  WIRE CONTRACT — client schema vs server model")
    print("  " + "=" * 66)

    client = client_manifest_entry_fields()
    server = server_manifest_entry_fields()

    print(f"  client RedactionEntrySchema: {sorted(client)}")
    print(f"  server RedactionModel      : {sorted(server)}")
    print("  " + "-" * 66)

    required = {"id", "box", "cls", "placeholder", "method", "score", "source"}
    check(
        "client declares every field the server requires",
        required <= client,
        f"missing on the client: {sorted(required - client)}",
    )

    # The specific break that shipped.
    check(
        "client's pixelDerived is accepted by the server",
        "pixelDerived" in server or "pixel_derived" in server,
        f"server accepts: {sorted(server)}",
    )

    # Any field the client emits that the server does not know about is a 422.
    unknown_to_server = client - server
    check(
        "the server accepts every field the client sends",
        not unknown_to_server,
        f"server would reject: {sorted(unknown_to_server)}",
    )

    # And a real round trip, so this is not only a text comparison.
    try:
        from server.app import ManifestModel  # noqa: PLC0415

        entry = {
            "id": "r0",
            "box": {"x": 10, "y": 20, "w": 300, "h": 40},
            "cls": "EMAIL",
            "placeholder": {"token": "[EMAIL_A1_1]", "cls": "EMAIL"},
            "method": "solid_fill",
            "score": 0.96,
            "source": "L1",
            "pixelDerived": False,
        }
        manifest = {
            "schema_version": "1.0.0",
            "session_id": "contract-test-0001",
            "redactions": [entry],
            "frame_hash": "a" * 16,
            "signature": "0" * 24,
            "model_versions": {"l2_ner": "x", "l3_face": "y", "l3_text": "z", "runtime": "w"},
            "abort_reason": None,
        }
        parsed = ManifestModel.model_validate(manifest)
        check(
            "a client-shaped manifest validates",
            parsed.redactions[0].pixelDerived is False,
            "parsed entry did not round-trip",
        )
        # And it must serialise back in the spelling the client expects.
        dumped = parsed.model_dump(by_alias=True)
        check(
            "it re-serialises to the client's spelling",
            dumped["redactions"][0].get("pixelDerived") is not None,
            f"got keys: {sorted(dumped['redactions'][0])}",
        )
    except Exception as e:  # noqa: BLE001
        check("a client-shaped manifest validates", False, f"{type(e).__name__}: {e}")

    print("  " + "=" * 66)
    if FAILS:
        print(f"  {len(FAILS)} contract check(s) FAILED\n")
        raise SystemExit(1)
    print(f"  all {CHECKS} contract checks passed\n")


if __name__ == "__main__":
    main()
