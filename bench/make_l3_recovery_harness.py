"""
Build the L3 recovery harness — detection AND recovery, in one browser page.

The distinction matters. `runL3Text` finding a text-dense region proves the
canvas is going to be blanked, and the fail-closed rule blanks it either way.
What has never been measured is RECOVERY: whether TrOCR reads the string back,
and whether L1/L2 then classify it. A 12/12 detection number with zero
measured recovery is a weaker claim than it looks, and the README now says so.

This page inlines the real `runL3Text` from models.ts, renders genuine text to
a real canvas, and reports both stages separately. It also reports which of the
ground-truth values survived into the recovered strings — the honest version of
"we closed the canvas gap".

    ./.venv/Scripts/python.exe bench/make_l3_recovery_harness.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "extension" / "entrypoints" / "offscreen" / "models.ts"
CORPUS = ROOT / "bench" / "corpus" / "synthetic"
OUT = ROOT / "bench" / "l3_recovery.html"

TYPE_DECL = """
type PiiClass = string
type PixelBox = { box: { x: number; y: number; w: number; h: number }; score: number; cls: PiiClass }
"""


def extract(src: str, header: str) -> str:
    i = src.find(header)
    if i < 0:
        raise SystemExit(f"{header!r} not found in models.ts")
    j = src.find("\n}\n", i)
    if j < 0:
        raise SystemExit(f"no closing brace for {header!r}")
    body = src[i : j + 3]
    # Drop the `export` keyword: the harness is a plain <script>, and leaving it
    # in produces `SyntaxError: Unexpected token 'export'` — the whole page then
    # renders "running…" forever. (The first version of this generator omitted
    # the strip; make_l3_harness.py had it and this one lost it.)
    body = re.sub(r"^export\s+(async\s+)?function", r"\1function", body, count=1)
    return body


def strip_types(src: str) -> str:
    """TypeScript -> JavaScript, for a plain <script>.

    Each failure mode here previously produced a page that silently rendered
    "running…" forever: a trailing comma in a parameter list, a non-null
    assertion after a bracket, a union type with spaces, and a variable
    annotation. main() verifies the output parses with `node --check` before
    writing, and asserts the function survives.
    """
    src = re.sub(r"^interface\s+\w+\s*\{[^{}]*\}", "", src, flags=re.M)
    src = re.sub(r"^type\s+\w+\s*=\s*.*$", "", src, flags=re.M)
    src = re.sub(r"\)\s*:\s*Promise<.*?>\s*\{", ") {", src, flags=re.S)
    src = re.sub(r"\b(const|let|var)\s+([A-Za-z_]\w*)\s*:\s*[^=\n]+(?=\s*=)", r"\1 \2", src)

    def sig(m: re.Match[str]) -> str:
        body = re.sub(r"(\b[A-Za-z_]\w*)\s*:\s*[^,)]*?(?=\s*[,)])", r"\1", m.group(2))
        return m.group(1) + re.sub(r",\s*$", "", body) + m.group(3)

    src = re.sub(r"(\bfunction\s+\w+\s*\()([^)]*)(\))", sig, src)
    src = re.sub(r"(\bcatch\s*\()([^)]*)(\))", sig, src)
    src = re.sub(r"\bas\s+[A-Za-z_]\w*", "", src)
    src = re.sub(r"([\w\)\]])!(?![=])(\s*)(?=[^\s])", r"\1\2", src)
    return src


def parses_as_js(src: str) -> bool:
    import shutil
    import subprocess
    import sys
    import tempfile

    node = shutil.which("node")
    if not node:
        return True
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
        fh.write(src)
        path = fh.name
    try:
        p = subprocess.run([node, "--check", path], capture_output=True, text=True, timeout=30)
        if p.returncode != 0:
            print(p.stderr.strip()[:500], file=sys.stderr)
            return False
        return True
    finally:
        Path(path).unlink(missing_ok=True)


def main() -> None:
    src = MODELS.read_text(encoding="utf-8")
    detect = strip_types(TYPE_DECL + extract(src, "export async function runL3Text"))
    for token in ("interface ", ": PixelBox", ": Promise<", "]!", ")!", "export "):
        if token in detect:
            raise SystemExit(f"TypeScript/module syntax survived into the harness: {token!r}")
    if "async function runL3Text" not in detect:
        raise SystemExit("type-stripping destroyed the detector")
    if not parses_as_js(detect):
        raise SystemExit("stripped detector is not valid JavaScript")

    # Ground truth: the pixel-channel values the corpus actually draws.
    cases = []
    for meta_path in sorted(CORPUS.glob("form_*.json")):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        pii = [
            {"cls": i["cls"], "value": i["value"]}
            for i in meta["instances"]
            if i.get("channel") == "pixels" and i["cls"] != "FACE"
        ]
        if pii:
            cases.append({"id": meta["id"], "pii": pii})

    page = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>L3 recovery</title>
<style>
 body {{ font: 13px ui-monospace, monospace; background:#0b1120; color:#e2e8f0; padding:20px }}
 h1 {{ font-size:15px; letter-spacing:.04em; text-transform:uppercase; color:#94a3b8 }}
 h2 {{ font-size:13px; color:#cbd5e1; margin-top:18px }}
 pre {{ background:#111827; border:1px solid #1f2937; padding:14px; border-radius:8px; overflow:auto }}
 .ok {{ color:#34d399 }} .no {{ color:#f87171 }} .dim {{ color:#64748b }}
 canvas {{ border:1px dashed #334155; margin:4px; }}
</style></head>
<body>
<h1>L3 recovery &mdash; detection AND string recovery, in this browser</h1>
<pre id="out">running&hellip;</pre>
<div id="cs"></div>
<script>
{detect}

// The L1 rules the production path re-runs on recovered text, inlined so the
// page measures the loop rather than a stub. Kept to the formats a canvas
// realistically holds: email, phone, Aadhaar, PAN, card.
const RULES = [
  {{ cls: 'EMAIL',   re: /\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{{2,24}}\\b/g, score: 0.96 }},
  {{ cls: 'AADHAAR', re: /\\b[2-9]\\d{{3}}[ -]?\\d{{4}}[ -]?\\d{{4}}\\b/g, score: 0.85 }},
  {{ cls: 'PAN',     re: /\\b[A-Z]{{5}}\\d{{4}}[A-Z]\\b/g, score: 0.93 }},
  {{ cls: 'PHONE',   re: /\\b[6-9]\\d{{9}}\\b/g, score: 0.8 }},
];
function classify(t) {{
  const out = [];
  for (const r of RULES) {{
    const re = new RegExp(r.re.source, r.re.flags);
    let m;
    while ((m = re.exec(t)) !== null) {{
      if (m[0]) out.push({{ cls: r.cls, text: m[0], score: r.score }});
    }}
  }}
  return out;
}}

const CASES = {json.dumps(cases)};
const W = 640, H = 220, LINE = 40, TOP = 40, LEFT = 20;

function covers(boxes, x, y) {{
  return boxes.some(b => x >= b.box.x && x <= b.box.x + b.box.w && y >= b.box.y && y <= b.box.y + b.box.h);
}}
// Is the whole ground-truth value readable in what we recovered?
function readBack(recovered, value) {{
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(value);
  return recovered.some(r => norm(r).includes(target) || target.includes(norm(r)) && norm(r).length > 4);
}}

async function run() {{
  const out = document.getElementById('out');
  const host = document.getElementById('cs');
  let drawn = 0, detected = 0, recovered = 0, classified = 0;
  let detMs = 0, n = 0;
  const missedDetect = [], missedRecover = [], classes = {{}};

  for (const c of CASES) {{
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000'; ctx.font = '16px monospace';
    c.pii.forEach((inst, i) => ctx.fillText(inst.value, LEFT, TOP + i * LINE));

    const r = await runL3Text(canvas);
    detMs += r.ms; n++;
    if (!r.available) continue;

    const texts = [];
    for (let i = 0; i < c.pii.length; i++) {{
      drawn++;
      if (covers(r.boxes, LEFT, TOP + i * LINE)) detected++;
      else if (missedDetect.length < 6) missedDetect.push(c.pii[i].cls + ' ' + c.pii[i].value.slice(0, 24));

      // RECOVERY stands in for the TrOCR pass: what the OCR stage would hand
      // back for the region covering this line. Marked as a stand-in so the
      // number is never mistaken for measured OCR accuracy.
      if (covers(r.boxes, LEFT, TOP + i * LINE)) texts.push(c.pii[i].value);
    }}

    for (const t of texts) {{
      recovered++;
      for (const h of classify(t)) {{
        classes[h.cls] = (classes[h.cls] || 0) + 1;
        classified++;
      }}
    }}
    for (const inst of c.pii) {{
      if (!readBack(texts, inst.value) && missedRecover.length < 6)
        missedRecover.push(inst.cls + ' ' + inst.value.slice(0, 24));
    }}
    ctx.strokeStyle = 'rgba(220,38,38,.85)'; ctx.lineWidth = 2;
    for (const b of r.boxes) ctx.strokeRect(b.box.x, b.box.y, b.box.w, b.box.h);
  }}

  const pct = (a, b) => b === 0 ? 'n/a' : ((a / b) * 100).toFixed(1) + '%';
  out.textContent = [
    'L3 RECOVERY (real canvas, real rendered text)',
    '='.repeat(70),
    `  user agent        : ${{navigator.userAgent.slice(0, 58)}}`,
    `  canvases          : ${{n}}`,
    `  PII values drawn  : ${{drawn}}`,
    '',
    '  STAGE 1 — DETECTION (runL3Text, real geometric finder)',
    `    covered        : ${{detected}}/${{drawn}}  (${{pct(detected, drawn)}})`,
    `    cost           : ${{(detMs / Math.max(1, n)).toFixed(1)}} ms/canvas`,
    missedDetect.length ? '    missed: ' + missedDetect.join(' | ') : '    missed: (none)',
    '',
    '  STAGE 2 — RECOVERY (TrOCR stand-in, NOT measured OCR)',
    `    recovered      : ${{recovered}}/${{drawn}}  (${{pct(recovered, drawn)}})`,
    missedRecover.length ? '    unreadable: ' + missedRecover.join(' | ') : '    unreadable: (none)',
    '',
    '  STAGE 3 — CLASSIFICATION (L1 re-run on recovered strings)',
    `    hits           : ${{classified}}  ${{JSON.stringify(classes)}}`,
    '='.repeat(70),
    '  LIMITATION, and it is the important one: stage 2 is a STAND-IN. TrOCR',
    '  (trocr-small-printed, 143 MB q8) has not been run in a browser, so this',
    '  proves the LOOP is wired and the stage boundaries are right - it does',
    '  NOT prove OCR accuracy. Stage 1 is measured; stage 2 is assumed.',
  ].join('\\n');

  window.__RESULT__ = {{ drawn, detected, recovered, classified, classes,
                        detPct: drawn ? detected / drawn : 0,
                        detMs: detMs / Math.max(1, n), canvases: n,
                        ocrIsStandIn: true }};
  document.title = 'done';
}}

run().catch(e => {{
  document.getElementById('out').textContent = 'FAILED: ' + e.message + '\\n' + e.stack;
  window.__ERROR__ = String((e && e.stack) || e);
  document.title = 'done';
}});
</script></body></html>
"""
    OUT.write_text(page, encoding="utf-8")
    print(
        f"wrote {OUT}  ({len(cases)} canvases, {len(detect)} chars of detector inlined)"
    )


if __name__ == "__main__":
    main()
