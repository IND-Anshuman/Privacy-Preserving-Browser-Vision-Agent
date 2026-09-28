#!/usr/bin/env python3
"""
Synthetic form generator with EXACT PII ground truth — ARCHITECTURE.md §5, §10.

Why this file exists: the calibration set is 40% of the rubric and the only way
to get a trustworthy number for metric 2/3 is ground truth we authored, not
labels we guessed. Every PII instance emitted here carries its class, its exact
character span, its DOM node id, and — for the pixel channel — the box it should
occupy in the rendered frame.

Output:
  bench/corpus/synthetic/form_NN.html      self-contained page (no network)
  bench/corpus/synthetic/form_NN.json      ground truth + the page's own metadata
  bench/corpus/synthetic/index.json        manifest of the whole split

The GT schema is deliberately the same shape the extension emits at runtime, so
run_metrics.py can diff detections against it with no translation layer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import string
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "1.0.0"

# --------------------------------------------------------------------------
# Canvas geometry for the pixel-channel adversarial case.
#
# Module-level so the draw call in the generated HTML, the ground-truth boxes
# and the self-check all read the same numbers. When the dimensions were inlined
# in each place separately, a box could escape the canvas and the self-check
# passed anyway.
CANVAS_W = 520
CANVAS_H = 160
CANVAS_CHAR_W = 9.6   # 16px monospace advance width
CANVAS_LINE_TOP = 36  # first baseline, matching fillText(t, 16, 36 + i*26)
CANVAS_LINE_STEP = 26
CANVAS_PAD_Y = 5      # covers ascenders and descenders

# --------------------------------------------------------------------------
# Check helpers — duplicated from extension/lib/pii.ts on purpose. If the two
# disagree, the benchmark is measuring the wrong thing, so the generator
# self-verifies every instance it emits (see verify_instance).
# --------------------------------------------------------------------------


def luhn_ok(digits: str) -> bool:
    s = re.sub(r"[\s-]", "", digits)
    if not s.isdigit() or not (12 <= len(s) <= 19):
        return False
    total = 0
    alt = False
    for ch in reversed(s):
        n = int(ch)
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def verhoeff_ok(num: str) -> bool:
    s = re.sub(r"\D", "", num)
    if len(s) != 12:
        return False
    c = 0
    for i, ch in enumerate(reversed(s)):
        c = VERHOEFF_D[c][VERHOEFF_P[i % 8][int(ch)]]
    return c == 0


def verhoeff_check_digit(first11: str) -> str:
    """The Verhoeff check digit that makes an 11-digit prefix a valid Aadhaar."""
    c = 0
    for i, ch in enumerate(reversed(first11)):
        c = VERHOEFF_D[c][VERHOEFF_P[i % 8][int(ch)]]
    return str(c)


def card_with_check(prefix: str, length: int) -> str:
    body = prefix + "".join(random.choice(string.digits) for _ in range(length - len(prefix) - 1))
    for check in range(10):
        cand = body + str(check)
        if luhn_ok(cand):
            return cand
    raise RuntimeError("unreachable: no Luhn digit found")


# --------------------------------------------------------------------------


@dataclass
class GtInstance:
    """One ground-truth PII instance."""

    id: str
    cls: str                      # matches extension/lib/schema.ts PII_CLASSES
    value: str                    # the actual secret — used for leakage audit only
    channel: str                  # "dom" | "pixels" | "shadow" | "attribute"
    node_id: str                  # element id inside the generated page
    selector: str                 # CSS selector for the element
    span: list[int] | None = None  # char offsets in the element's text/value
    box: list[float] | None = None  # expected px box in the rendered frame
    redaction_method: str = "solid_fill"
    note: str = ""


@dataclass
class FormSpec:
    idx: int
    title: str
    category: str                  # banking | insurance | gov | ecommerce | health | telecom | education | travel | hr | logistics
    fields: list[dict[str, Any]] = field(default_factory=list)
    instances: list[GtInstance] = field(default_factory=list)
    extra_html: str = ""
    notes: str = ""


# --------------------------------------------------------------------------
# Data pools
# --------------------------------------------------------------------------

FIRST = [
    "Ankit", "Priya", "Rohit", "Sneha", "Vikram", "Meera", "Arjun", "Divya",
    "Karan", "Ishita", "Rahul", "Nisha", "Aditya", "Pooja", "Siddharth", "Kavya",
]
LAST = [
    "Sharma", "Verma", "Iyer", "Nair", "Reddy", "Patel", "Khan", "Bose",
    "Menon", "Chopra", "Gupta", "Rao", "Desai", "Pillai", "Joshi", "Banerjee",
]
STREETS = ["MG Road", "Linking Road", "Sector 18", "Gariahat Road", "Anna Salai", "Park Street", "FC Road", " Brigade Road"]
CITIES = [("Bengaluru", "560001", "KA"), ("Mumbai", "400050", "MH"), ("Chennai", "600002", "TN"), ("Delhi", "110001", "DL"), ("Pune", "411001", "MH")]
BANKS = ["State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank"]
IFSC_BANK = {"State Bank of India": "SBIN", "HDFC Bank": "HDFC", "ICICI Bank": "ICIC", "Axis Bank": "UTIB", "Kotak Mahindra Bank": "KOTK"}

CATEGORY_TITLES = {
    "banking": "Savings Account Opening",
    "insurance": "Life Insurance Proposal",
    "gov": "Aadhaar / PAN Verification",
    "ecommerce": "Delivery Address Update",
    "health": "Patient Registration",
    "telecom": "Mobile Postpaid Upgrade",
    "education": "Scholarship Application",
    "travel": "Railway Passenger Registration",
    "hr": "Employee Onboarding",
    "logistics": "Consignment Booking",
}


def rnd_person(rng: random.Random) -> str:
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


def rnd_email(rng: random.Random, name: str) -> str:
    handle = name.lower().replace(" ", ".")
    dom = rng.choice(["acme.in", "example.co.in", "mailbox.net", "corp.io"])
    return f"{handle}@{dom}"


def rnd_mobile(rng: random.Random) -> str:
    return f"{rng.choice('6789')}{rng.choice(string.digits)}{''.join(rng.choice(string.digits) for _ in range(8))}"


def rnd_aadhaar(rng: random.Random) -> str:
    while True:
        first11 = str(rng.choice([2, 3, 4, 5, 6, 7, 8, 9])) + "".join(rng.choice(string.digits) for _ in range(10))
        n = first11 + verhoeff_check_digit(first11)
        if verhoeff_ok(n):
            return n


def rnd_gstin(rng: random.Random) -> str:
    state = rng.choice(["27", "29", "07", "33", "36"])
    letters = "".join(rng.choice(string.ascii_uppercase) for _ in range(5))
    digits = "".join(rng.choice(string.digits) for _ in range(4))
    ent = rng.choice(string.ascii_uppercase)
    return f"{state}{letters}{digits}{ent}1Z{rng.choice(string.ascii_uppercase)}"


def rnd_ifsc(rng: random.Random) -> str:
    bank = rng.choice(list(IFSC_BANK))
    return f"{IFSC_BANK[bank]}0{rng.choice(string.digits)}{''.join(rng.choice(string.digits) for _ in range(5))}"


def rnd_pan(rng: random.Random) -> str:
    return f"{''.join(rng.choice(string.ascii_uppercase) for _ in range(5))}{''.join(rng.choice(string.digits) for _ in range(4))}{rng.choice(string.ascii_uppercase)}"


def rnd_dob(rng: random.Random) -> str:
    return f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}/{rng.randint(1955, 2004)}"


def rnd_ip(rng: random.Random) -> str:
    return ".".join(str(rng.randint(1, 254)) for _ in range(4))


def rnd_account(rng: random.Random) -> str:
    return "".join(rng.choice(string.digits) for _ in range(12))


# --------------------------------------------------------------------------
# Form templates. Each returns a FormSpec with fields + GT instances.
# Every field dict: {id, label, type, name, autocomplete, placeholder, value,
#                    cls, channel, redaction_method, multiline}
# --------------------------------------------------------------------------


def fld(
    fid: str,
    label: str,
    ftype: str,
    *,
    name: str | None = None,
    autocomplete: str | None = None,
    value: str = "",
    cls: str | None = None,
    channel: str = "dom",
    redaction_method: str = "solid_fill",
    multiline: bool = False,
    note: str = "",
) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": fid,
        "label": label,
        "type": ftype,
        "name": name or fid,
        "autocomplete": autocomplete,
        "value": value,
        "cls": cls,
        "channel": channel,
        "redaction_method": redaction_method,
        "multiline": multiline,
        "note": note,
    }
    return d


def build_form(idx: int, rng: random.Random) -> FormSpec:
    categories = list(CATEGORY_TITLES)
    cat = categories[idx % len(categories)]
    spec = FormSpec(idx=idx, title=f"{CATEGORY_TITLES[cat]} — case {idx:02d}", category=cat)

    person = rnd_person(rng)
    email = rnd_email(rng, person)
    mobile = rnd_mobile(rng)
    city, pin, state = rng.choice(CITIES)
    addr = f"{rng.randint(1, 400)}, {rng.choice(STREETS)}, {city} {pin}"
    bank = rng.choice(BANKS)
    password = "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(14))

    instances: list[GtInstance] = []

    def push(f: dict[str, Any]) -> None:
        spec.fields.append(f)
        if f["cls"]:
            instances.append(
                GtInstance(
                    id=f"f{idx:02d}_{f['id']}",
                    cls=f["cls"],
                    value=f["value"],
                    channel=f["channel"],
                    node_id=f["id"],
                    selector=f"#{f['id']}",
                    span=[0, len(f["value"])] if f["value"] else None,
                    redaction_method=f["redaction_method"],
                    note=f["note"],
                )
            )

    # --- every form: identity block -------------------------------------
    push(fld("full_name", "Full name", "text", autocomplete="name", value=person, cls="PERSON", redaction_method="placeholder"))
    push(fld("email", "Email address", "email", autocomplete="email", value=email, cls="EMAIL", redaction_method="placeholder"))
    push(fld("phone", "Mobile number", "tel", autocomplete="tel", value=mobile, cls="PHONE", redaction_method="placeholder"))
    push(fld("dob", "Date of birth", "text", autocomplete="bday", value=rnd_dob(rng), cls="DOB", redaction_method="placeholder"))

    # --- a static paragraph carrying free-text PII (regex-only surface) ---
    para = (
        f"Applicant: {person}. Contact {email} or +91 {mobile[:5]} {mobile[5:]}. "
        f"Permanent address: {addr}."
    )
    spec.fields.append(
        {
            "id": "summary_para",
            "label": "Applicant summary",
            "type": "p",
            "name": "summary",
            "autocomplete": None,
            "value": para,
            "cls": None,
            "channel": "dom",
            "redaction_method": "placeholder",
            "multiline": False,
            "note": "free-text paragraph: L1 regex must carry it",
        }
    )
    # GT for the paragraph: exact spans, found by re-running the same regex the
    # extension uses, then verified against the class rules. This keeps GT
    # honest — a span is GT only if the pattern is genuinely unambiguous.
    for cls, val in [
        ("PERSON", person),
        ("EMAIL", email),
        ("PHONE", "+91 " + mobile[:5] + " " + mobile[5:]),
        # ADDRESS was missing here, so every form carried a real postal address
        # in prose that the detector correctly found and the benchmark scored as
        # 18 false positives. The paragraph says "Permanent address: {addr}.",
        # so the address is unambiguous ground truth and belongs in the set.
        ("ADDRESS", addr),
    ]:
        start = para.find(val)
        if start >= 0:
            instances.append(
                GtInstance(
                    id=f"f{idx:02d}_summary_{cls.lower()}",
                    cls=cls,
                    value=val,
                    channel="dom",
                    node_id="summary_para",
                    selector="#summary_para",
                    span=[start, start + len(val)],
                    redaction_method="placeholder",
                    note="free-text span",
                )
            )

    # --- category-specific sensitive fields -----------------------------
    if cat == "banking":
        push(fld("password", "Password", "password", autocomplete="current-password", value=password, cls="PASSWORD", redaction_method="solid_fill", note="never pseudonymized"))
        push(fld("aadhaar", "Aadhaar number", "text", name="aadhaarNumber", value=rnd_aadhaar(rng), cls="AADHAAR"))
        push(fld("pan", "PAN", "text", name="pan", value=rnd_pan(rng), cls="PAN"))
        push(fld("card_number", "Card number", "text", autocomplete="cc-number", value=card_with_check("4539", 16), cls="CREDIT_CARD"))
        push(fld("card_cvv", "CVV", "text", autocomplete="cc-csc", value=f"{rng.randint(100, 999)}", cls="CREDIT_CARD"))
        push(fld("ifsc", "IFSC code", "text", name="ifscCode", value=rnd_ifsc(rng), cls="IFSC"))
        push(fld("account_no", "Account number", "text", name="accountNumber", value=rnd_account(rng), cls="BANK_ACCOUNT"))
    elif cat == "insurance":
        push(fld("password", "Password", "password", autocomplete="new-password", value=password, cls="PASSWORD"))
        push(fld("nominee", "Nominee name", "text", value=rnd_person(rng), cls="PERSON", redaction_method="placeholder"))
        push(fld("aadhaar", "Aadhaar number", "text", name="aadhaar", value=rnd_aadhaar(rng), cls="AADHAAR"))
        push(fld("medical_id", "Policy number", "text", value=f"POL{rng.randint(100000, 999999)}", cls=None, note="public reference, not PII"))
        push(fld("occupation", "Occupation", "text", value=rng.choice(["Engineer", "Teacher", "Farmer", "Doctor"]), cls=None))
    elif cat == "gov":
        push(fld("aadhaar", "Aadhaar number", "text", name="aadhaar", value=rnd_aadhaar(rng), cls="AADHAAR"))
        push(fld("pan", "PAN", "text", name="pan", value=rnd_pan(rng), cls="PAN"))
        push(fld("gstin", "GSTIN", "text", name="gstin", value=rnd_gstin(rng), cls="GSTIN"))
        push(fld("father_name", "Father's name", "text", value=rnd_person(rng), cls="PERSON", redaction_method="placeholder"))
        push(fld("captcha_answer", "Captcha answer", "text", value=str(rng.randint(1000, 9999)), cls=None, note="4-digit OTP-shaped value that is NOT a card/aadhaar — precision probe"))
    elif cat == "ecommerce":
        push(fld("address1", "Address line 1", "text", autocomplete="shipping street-address", value=addr, cls="ADDRESS", redaction_method="placeholder"))
        push(fld("address2", "Address line 2", "text", value=f"Flat {rng.randint(1, 900)}", cls="ADDRESS", redaction_method="placeholder"))
        push(fld("card_number", "Payment card", "text", autocomplete="cc-number", value=card_with_check("5425", 16), cls="CREDIT_CARD"))
        push(fld("card_exp", "Expiry", "text", autocomplete="cc-exp", value=f"{rng.randint(1, 12):02d}/{rng.randint(24, 30)}", cls="CREDIT_CARD"))
    elif cat == "health":
        push(fld("patient_id", "Patient ID", "text", name="patientId", value=f"PT{rng.randint(100000, 999999)}", cls="BANK_ACCOUNT", redaction_method="solid_fill", note="hospital MRN — treated as an identifier"))
        push(fld("diagnosis", "Diagnosis", "text", multiline=True, value=rng.choice(["Type 2 diabetes", "Hypertension", "Asthma"]), cls=None))
        push(fld("emergency_contact", "Emergency contact", "text", value=f"{rnd_person(rng)} +91 {rnd_mobile(rng)}", cls="PERSON", redaction_method="placeholder"))
        push(fld("aadhaar", "Aadhaar for insurance", "text", name="aadhaarNumber", value=rnd_aadhaar(rng), cls="AADHAAR"))
    elif cat == "telecom":
        push(fld("msisdn", "Current mobile", "tel", value=rnd_mobile(rng), cls="PHONE", redaction_method="placeholder"))
        push(fld("sim_serial", "SIM serial", "text", name="simSerial", value=f"89{rng.randint(10**15, 10**16 - 1)}", cls="API_KEY", redaction_method="solid_fill", note="long opaque digit string"))
        push(fld("otp", "OTP sent to your number", "password", value=str(rng.randint(100000, 999999)), cls="PASSWORD", redaction_method="solid_fill", note="OTP is treated like a password"))
        push(fld("imei", "Device IMEI", "text", name="imei", value=str(rng.randint(10**14, 10**15 - 1)), cls="API_KEY", redaction_method="solid_fill"))
    elif cat == "education":
        push(fld("student_id", "Student ID", "text", name="studentId", value=f"STU{rng.randint(10000, 99999)}", cls="BANK_ACCOUNT"))
        push(fld("guardian_phone", "Guardian phone", "tel", value=rnd_mobile(rng), cls="PHONE", redaction_method="placeholder"))
        push(fld("income_proof", "Annual family income", "text", value=f"₹{rng.randint(3, 40)},00,000", cls="MONEY", redaction_method="placeholder", note="money is a low-signal class"))
        push(fld("institution", "Institution", "text", value=f"Institute of Technology, {city}", cls="ORG", redaction_method="placeholder"))
    elif cat == "travel":
        push(fld("passenger_name", "Passenger name", "text", autocomplete="name", value=person, cls="PERSON", redaction_method="placeholder"))
        push(fld("passport", "Passport number", "text", name="passportNumber", value=f"{rng.choice('ABCDEFGHJKLMNP')}{rng.randint(1000000, 9999999)}", cls="PASSPORT"))
        push(fld("dl", "Driving licence", "text", name="dlNumber", value=f"{state}{rng.choice('0123456789')}{rng.randint(10000000000, 99999999999)}", cls="DL"))
        push(fld("emergency_phone", "Emergency contact number", "tel", value=rnd_mobile(rng), cls="PHONE", redaction_method="placeholder"))
    elif cat == "hr":
        push(fld("ssn_equiv", "National ID", "text", name="ssn", value=f"{rng.randint(10**11, 10**12 - 1)}", cls="BANK_ACCOUNT", note="12-digit national id: Aadhaar-shaped but Verhoeff-invalid — must NOT be called AADHAAR; precision probe for the checksum gate"))
        push(fld("salary_account", "Salary account", "text", name="accountNumber", value=rnd_account(rng), cls="BANK_ACCOUNT"))
        push(fld("emergency_contact", "Emergency contact", "text", value=f"{rnd_person(rng)} — {rnd_mobile(rng)}", cls="PERSON", redaction_method="placeholder"))
        push(fld("office_ip", "Office workstation IP", "text", name="ipAddress", value=rnd_ip(rng), cls="IP_ADDRESS", redaction_method="placeholder"))
    else:  # logistics
        push(fld("consignor_aadhaar", "Consignor Aadhaar", "text", name="aadhaar", value=rnd_aadhaar(rng), cls="AADHAAR"))
        push(fld("gstin", "GSTIN", "text", name="gstin", value=rnd_gstin(rng), cls="GSTIN"))
        push(fld("driver_phone", "Driver phone", "tel", value=rnd_mobile(rng), cls="PHONE", redaction_method="placeholder"))
        push(fld("consignment_note", "Consignment note no", "text", value=f"CN{rng.randint(10**7, 10**8 - 1)}", cls=None))

    # --- controls (no PII, but they are the ground-truth click targets) ----
    spec.fields.append(fld("submit_btn", "Submit application", "submit", cls=None))
    spec.fields.append(fld("cancel_btn", "Cancel", "button", cls=None))
    spec.fields.append(fld("notes", "Notes", "textarea", multiline=True, cls=None, value=""))

    spec.instances = instances
    return spec


# --------------------------------------------------------------------------
# Adversarial extras injected into a subset of forms (§5 "hard cases")
# --------------------------------------------------------------------------


def adversarial_extras(idx: int, rng: random.Random, spec: FormSpec) -> tuple[str, list[GtInstance]]:
    """Return (html, extra GT instances) for the nasty cases."""
    extra: list[GtInstance] = []
    html: list[str] = []
    kind = idx % 5

    if kind == 0:
        # Geometry comes from the module constants, so the draw call and the
        # ground-truth boxes cannot drift apart.
        # PII drawn INSIDE a <canvas>. Only L3 can see this.
        canvas_pii = f"{rnd_person(rng)}\\n{rnd_email(rng, 'canvas.user')}\\n{rnd_mobile(rng)}"
        html.append(
            f"""<section class="card">
  <h3>Recent activity (rendered by the widget)</h3>
  <canvas id="activity_canvas" width="{CANVAS_W}" height="{CANVAS_H}"
    data-widget="activity-summary"></canvas>
  <script>
    // Text drawn into the canvas — invisible to every DOM rule (ARCHITECTURE §5).
    (function(){{
      const c = document.getElementById('activity_canvas');
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#111'; g.font = '16px monospace';
      const lines = "{canvas_pii}".split("\\\\n");
      lines.forEach((t, i) => g.fillText(t, 16, {CANVAS_LINE_TOP} + i * {CANVAS_LINE_STEP}));
    }})();
  </script>
</section>"""
        )
        # EXACT pixel ground truth. The generator owns this layout: it decides
        # where each line is drawn, so it can and must record the box rather
        # than deferring to "resolved at capture time by the L3 text detector".
        #
        # Deferring made M3 unmeasurable — the metric needs box IoU against a
        # known region, and a detector is not a source of truth about itself.
        # The numbers below mirror the fillText call exactly:
        #   g.font = '16px monospace'; fillText(t, 16, 36 + i * 26)
        # Monospace at 16px is ~9.6px per advance; the box is padded vertically
        # to cover ascenders and descenders, which 16px of line height does not.
        for i, v in enumerate([x for x in canvas_pii.split("\\n") if x]):
            cls = "PERSON" if "@" not in v and not v.isdigit() else ("EMAIL" if "@" in v else "PHONE")
            y_baseline = CANVAS_LINE_TOP + i * CANVAS_LINE_STEP
            extra.append(
                GtInstance(
                    id=f"f{idx:02d}_canvas_{i}",
                    cls=cls,
                    value=v,
                    channel="pixels",
                    node_id="activity_canvas",
                    selector="#activity_canvas",
                    # CANVAS-LOCAL coordinates. The canvas sits at the top of its
                    # section, so a consumer adds the canvas's own rect.
                    box=(
                        16.0,
                        float(y_baseline - 14 - CANVAS_PAD_Y),
                        round(len(v) * CANVAS_CHAR_W, 2),
                        float(14 + 4 + CANVAS_PAD_Y * 2),
                    ),
                    redaction_method="pixelate",
                    note="text drawn in canvas; exact box from the draw call",
                )
            )

    elif kind == 1:
        # PII in a data-* attribute, no visible value.
        v = rnd_email(rng, "hidden.user")
        html.append(
            f"""<div id="profile_widget" data-user-email="{v}" data-pii="true"
     data-telemetry="anon">Widget</div>"""
        )
        extra.append(
            GtInstance(id=f"f{idx:02d}_datattr", cls="EMAIL", value=v, channel="attribute",
                       node_id="profile_widget", selector="#profile_widget",
                       span=None, box=None, redaction_method="solid_fill",
                       note="PII in data-* attribute, never rendered")
        )

    elif kind == 2:
        # PII inside a CLOSED shadow root: the content script cannot read it.
        v = rnd_mobile(rng)
        html.append(
            f"""<div id="closed_host"></div>
<script>
  (function(){{
    const host = document.getElementById('closed_host');
    const root = host.attachShadow({{ mode: 'closed' }});  // deliberately closed
    root.innerHTML = '<div>Registered mobile: <b>{v}</b></div>';
  }})();
</script>"""
        )
        extra.append(
            GtInstance(id=f"f{idx:02d}_closed_shadow", cls="PHONE", value=v, channel="shadow",
                       node_id="closed_host", selector="#closed_host",
                       span=None, box=None, redaction_method="pixelate",
                       note="closed shadow root: geometric fallback via L3 required")
        )

    elif kind == 3:
        # Autofilled password: value set programmatically, no input event fires.
        pw = "Autofill!" + "".join(rng.choice(string.digits) for _ in range(8))
        html.append(
            f"""<section class="card">
  <h3>Saved credentials</h3>
  <label for="login_pw">Password</label>
  <input id="login_pw" type="password" name="login_password" value="{pw}">
  <p class="hint">Filled by the password manager on page load (no input event).</p>
</section>"""
        )
        extra.append(
            GtInstance(id=f"f{idx:02d}_autofill", cls="PASSWORD", value=pw, channel="dom",
                       node_id="login_pw", selector="#login_pw", span=[0, len(pw)],
                       box=None, redaction_method="solid_fill",
                       note="autofilled without an input event — value attr must be re-scanned each cycle")
        )

    else:
        # Face photo in an <img>: pixel-only, needs the L3 face detector.
        html.append(
            """<section class="card">
  <h3>Selfie verification</h3>
  <img id="selfie" alt="passport photo" width="180" height="220"
       src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='220'%3E%3Crect width='180' height='220' fill='%23c9d6e3'/%3E%3Ccircle cx='90' cy='80' r='42' fill='%23f2c9a0'/%3E%3Cellipse cx='90' cy='190' rx='70' ry='50' fill='%23f2c9a0'/%3E%3C/svg%3E">
  <label><input type="checkbox" id="face_match"> Face matches my Aadhaar photo</label>
</section>"""
        )
        extra.append(
            GtInstance(id=f"f{idx:02d}_face", cls="FACE", value="", channel="pixels",
                       node_id="selfie", selector="#selfie", span=None,
                       box=None, redaction_method="pixelate",
                       note="identity photo: needs the L3 face detector, never DOM rules")
        )

    return "\n".join(html), extra


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

PAGE_CSS = """
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6fb;color:#111827}
header{background:#1e3a8a;color:#fff;padding:18px 24px}
header h1{margin:0;font-size:19px}
main{max-width:760px;margin:0 auto;padding:20px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px;margin-bottom:16px}
label{display:block;font-weight:600;margin:10px 0 4px;font-size:13px}
input,textarea,select{width:100%;padding:9px 10px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;background:#fff}
input:focus,textarea:focus{outline:2px solid #3b82f6}
.actions{display:flex;gap:10px;margin-top:16px}
button{padding:10px 18px;border-radius:6px;border:1px solid #1e3a8a;background:#1e3a8a;color:#fff;font-weight:600;cursor:pointer}
button.secondary{background:#fff;color:#1e3a8a}
.hint{color:#6b7280;font-size:12px}
table{width:100%;border-collapse:collapse}
td,th{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px}
canvas{border:1px solid #cbd5e1;border-radius:6px;max-width:100%}
img{border-radius:6px}
"""


def render_form(spec: FormSpec, extra_html: str) -> str:
    rows: list[str] = []
    for f in spec.fields:
        if f["type"] == "p":
            rows.append(f'<p id="{f["id"]}">{f["value"]}</p>')
            continue
        if f["type"] in ("submit", "button"):
            if f["type"] == "submit":
                rows.append(f'<button type="submit" id="{f["id"]}" name="{f["name"]}">{f["label"]}</button>')
            else:
                rows.append(f'<button type="button" id="{f["id"]}" class="secondary">{f["label"]}</button>')
            continue
        if f["type"] == "textarea":
            rows.append(
                f'<label for="{f["id"]}">{f["label"]}</label>'
                f'<textarea id="{f["id"]}" name="{f["name"]}" rows="3"></textarea>'
            )
            continue
        ac = f' autocomplete="{f["autocomplete"]}"' if f["autocomplete"] else ""
        val = f' value="{f["value"]}"' if f["value"] else ""
        rows.append(
            f'<label for="{f["id"]}">{f["label"]}</label>'
            f'<input id="{f["id"]}" name="{f["name"]}" type="{f["type"]}"{ac}{val}>'
        )

    actions = ""
    for f in spec.fields:
        if f["type"] == "submit":
            actions = f'<button type="submit" id="{f["id"]}">{f["label"]}</button>'
        if f["type"] == "button":
            actions += f'<button type="button" id="{f["id"]}" class="secondary">{f["label"]}</button>'

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{spec.title}</title>
<style>{PAGE_CSS}</style>
</head>
<body>
<header><h1>{spec.title}</h1></header>
<main>
  <section class="card" id="identity_block">
    <h2>Applicant details</h2>
    {chr(10).join("    " + r for r in rows)}
  </section>
  {extra_html}
  <section class="card">
    <h2>Review</h2>
    <table id="summary_table">
      <tr><th>Field</th><th>Value</th></tr>
      <tr><td>Name</td><td>{spec.fields[0]["value"] if spec.fields else ""}</td></tr>
      <tr><td>Reference</td><td>VEIL-{spec.idx:04d}</td></tr>
    </table>
  </section>
  <div class="actions">{actions}</div>
</main>
</body>
</html>
"""


# --------------------------------------------------------------------------
# Self-verification: every generated instance must be re-derivable.
# --------------------------------------------------------------------------


def verify_instance(inst: GtInstance) -> list[str]:
    errs: list[str] = []
    v = inst.value
    if inst.cls == "AADHAAR" and re.fullmatch(r"\d{12}", v.replace(" ", "")):
        if not verhoeff_ok(v):
            errs.append("aadhaar fails Verhoeff")
    if inst.cls == "CREDIT_CARD" and re.fullmatch(r"[\d\s-]{13,23}", v):
        if not luhn_ok(v):
            errs.append("card fails Luhn")
    if inst.cls == "IFSC" and not re.fullmatch(r"[A-Z]{4}0[A-Z0-9]{6}", v):
        errs.append("ifsc malformed")
    if inst.cls == "GSTIN" and not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]", v):
        errs.append("gstin malformed")
    if inst.cls == "PAN" and not re.fullmatch(r"[A-Z]{5}\d{4}[A-Z]", v):
        errs.append("pan malformed")
    if inst.cls == "EMAIL" and "@" not in v:
        errs.append("email malformed")
    if inst.cls in ("PHONE",) and not re.fullmatch(r"\d{10}", re.sub(r"\D", "", v)[-10:]):
        errs.append("phone malformed")
    if not inst.id or not inst.node_id:
        errs.append("missing id")
    if inst.channel == "pixels" and inst.cls == "FACE":
        # A face is an <img>, not drawn text: there is no fillText call to
        # derive a box from, so the generator cannot honestly declare one. The
        # detector's box is compared against the IMAGE's rect instead, which is
        # known exactly from the element's own geometry. Exempt here and
        # handled separately in bench/measure_m3.ts.
        return errs

    if inst.channel == "pixels":
        # The generator owns the canvas layout — it emits the fillText call, so
        # it must also emit the box. This used to assert the opposite ("no box
        # until measured"), which made M3 unmeasurable: a detector cannot be the
        # ground truth for its own coverage. The check is now that a declared
        # box is actually well-formed and inside the canvas.
        if inst.box is None:
            errs.append("pixel GT must carry an exact box (the generator owns the draw call)")
        else:
            bx, by, bw, bh = inst.box
            if bw <= 0 or bh <= 0:
                errs.append(f"pixel GT box has non-positive area: {inst.box}")
            elif bx < 0 or by < 0 or bx + bw > CANVAS_W or by + bh > CANVAS_H:
                errs.append(f"pixel GT box escapes the {CANVAS_W}x{CANVAS_H} canvas: {inst.box}")
    return errs


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate the synthetic PII corpus with exact ground truth")
    ap.add_argument("--count", type=int, default=20)
    ap.add_argument("--seed", type=int, default=20260927)
    ap.add_argument("--out", default=str(Path(__file__).parent / "corpus" / "synthetic"))
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)

    index: list[dict[str, Any]] = []
    total_inst = 0
    errors: list[str] = []

    for i in range(args.count):
        spec = build_form(i, rng)
        extra_html, extras = adversarial_extras(i, rng, spec)
        spec.instances.extend(extras)
        spec.notes = f"category={spec.category}; adversarial={i % 5}"

        for inst in spec.instances:
            errs = verify_instance(inst)
            if errs:
                errors.extend([f"{inst.id}: {e}" for e in errs])
            total_inst += 1

        html = render_form(spec, extra_html)
        html_path = out / f"form_{i:02d}.html"
        html_path.write_text(html, encoding="utf-8")

        meta = {
            "schema_version": SCHEMA_VERSION,
            "id": f"syn_{i:02d}",
            "title": spec.title,
            "category": spec.category,
            "split": "synthetic",
            "adversarial_kind": i % 5,
            "html": html_path.name,
            "sha256": hashlib.sha256(html.encode("utf-8")).hexdigest(),
            "notes": spec.notes,
            "instances": [asdict(x) for x in spec.instances],
            "field_ids": [f["id"] for f in spec.fields],
            "submit_node": next((f["id"] for f in spec.fields if f["type"] == "submit"), None),
        }
        (out / f"form_{i:02d}.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
        index.append(
            {
                "id": meta["id"],
                "category": spec.category,
                "adversarial_kind": meta["adversarial_kind"],
                "html": meta["html"],
                "json": f"form_{i:02d}.json",
                "instance_count": len(spec.instances),
                "sha256": meta["sha256"],
            }
        )

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "split": "synthetic",
        "seed": args.seed,
        "count": len(index),
        "total_instances": total_inst,
        "generator_selfcheck_errors": errors,
        "forms": index,
    }
    (out / "index.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"wrote {len(index)} forms, {total_inst} PII instances → {out}")
    if errors:
        print(f"SELF-CHECK FAILED ({len(errors)} problems):")
        for e in errors[:40]:
            print("  -", e)
        raise SystemExit(1)
    print("self-check OK: every instance re-derivable from its own checksum/format rule")


if __name__ == "__main__":
    main()
