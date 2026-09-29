"""The /live endpoint must be fast, and must not resolve a provider.

Added because the panel showed "server unreachable (timeout)" about a server
that was running and healthy: it was calling /health — which probes the remote
provider and measured p50 2.91s / max 4.79s — with a 4000ms budget, to answer
"is the server running?".
"""
import os
import sys
import time

os.environ.setdefault("VEIL_LLM_PROVIDER", "fake")
os.environ.setdefault("VEIL_ALLOWED_ORIGINS", "dev")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from server.app import app  # noqa: E402

client = TestClient(app)

fails = 0
total = 0


def check(name, cond, detail=""):
    """Print one check and tally it. The gate requires an explicit n/n."""
    global fails, total
    total += 1
    if not cond:
        fails += 1
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")


print("liveness endpoint")
times = []
for _ in range(3):
    t0 = time.time()
    r = client.get("/live")
    times.append((time.time() - t0) * 1000)
    if r.status_code != 200:
        break
check("returns 200", r.status_code == 200, f"got {r.status_code}")
body = r.json()
check("reports ok", body.get("ok") is True, str(body))
check(
    "exposes no provider or model config",
    "provider" not in body and "model" not in body,
    str(sorted(body)),
)
# The panel budgets 2000ms. It has to clear that by a wide margin or the
# status line is still at the mercy of whatever /live happens to touch.
check(
    "answers far inside the 2s panel budget",
    max(times) < 200,
    f"max {max(times):.1f}ms over 3 calls (budget 2000ms)",
)

print("\n/health is still the slow, provider-resolving check")
t0 = time.time()
rh = client.get("/health")
print(f"  /health {rh.status_code} in {time.time() - t0:.2f}s (fake provider, no network)")

passed = total - fails
print(f"\n{passed}/{total} passed (liveness)")
sys.exit(1 if fails else 0)
