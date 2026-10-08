#!/usr/bin/env python3
"""Price Robot.

Reads the private Master Sheet, keeps only 5 safe fields
(Brand, M-Model, Part Description, Part Number, Selling Price),
encrypts them with the site password and writes docs/data.enc.json.

Current Price, Currency, Category Code (Sir) and Price Date are read
but never written anywhere. The log prints counts only, never prices.
"""
import base64
import datetime as dt
import json
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HEADERS = [
    "sr no.", "m-model", "brand", "part description", "part number",
    "current price", "currency", "category code (sir)", "selling price (inr)", "price date",
]
C_MODEL, C_BRAND, C_DESC, C_PART, C_SELL = 1, 2, 3, 4, 8
ITERATIONS = 600_000
ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "docs" / "data.enc.json"
HEARTBEAT_FILE = ROOT / "docs" / "heartbeat.txt"
IST = ZoneInfo("Asia/Kolkata")


def stop(reason):
    print(f"STOPPED: {reason}.")
    print("Nothing was published. The last good prices stay live.")
    sys.exit(1)


def secret(name):
    value = os.environ.get(name, "").strip()
    if not value:
        stop(f"the secret {name} is missing (GitHub > Settings > Secrets and variables > Actions)")
    return value


# ---------- 1. Read the sheet (read-only) ----------
def read_sheet(sheet_id, key_json):
    from google.auth.exceptions import GoogleAuthError
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    try:
        info = json.loads(key_json)
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    except Exception:
        stop("GOOGLE_SA_KEY is not a valid key - paste the WHOLE .json key file into the secret")

    session = AuthorizedSession(creds)
    base = f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}"

    def get(url, params):
        try:
            r = session.get(url, params=params, timeout=60)
        except GoogleAuthError:
            stop("Google rejected the robot's key (deleted or disabled?) - create a new key")
        except Exception as e:  # network trouble; do not print the URL
            stop(f"could not reach Google ({type(e).__name__}) - it will retry at the next run")
        if r.status_code == 403:
            stop("the robot cannot open the sheet - share it with the robot's email as Viewer")
        if r.status_code == 404:
            stop("sheet not found - check the SHEET_ID secret")
        if not r.ok:
            stop(f"Google returned error {r.status_code}")
        return r.json()

    meta = get(base, {"fields": "sheets.properties.title"})
    tabs = [s["properties"]["title"] for s in meta.get("sheets", [])]
    tabs = [t for t in tabs if not t.startswith("_")]
    if not tabs:
        stop("the sheet has no tabs to read")
    ranges = ["'" + t.replace("'", "''") + "'!A1:J" for t in tabs]
    values = get(base + "/values:batchGet",
                 {"ranges": ranges, "valueRenderOption": "UNFORMATTED_VALUE", "majorDimension": "ROWS"})
    return [(t, vr.get("values", [])) for t, vr in zip(tabs, values.get("valueRanges", []))]


# ---------- 2. Keep only the 5 safe fields ----------
def norm_header(h):
    return " ".join(str(h).split()).lower()


def as_text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return " ".join(str(v).split())


def as_price(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
        return None  # blank, text or error -> "Price on request"
    return round(float(v), 2)


def cell(row, i):
    return row[i] if i < len(row) else ""


def build_rows(tabs):
    rows, used = [], 0
    for _title, values in tabs:
        if not values or [norm_header(h) for h in values[0][:10]] != HEADERS:
            continue  # not a price tab (e.g. SETTINGS) -> skipped
        used += 1
        for r in values[1:]:
            desc, part = as_text(cell(r, C_DESC)), as_text(cell(r, C_PART))
            if not desc and not part:
                continue
            rows.append({
                "brand": as_text(cell(r, C_BRAND)),
                "model": as_text(cell(r, C_MODEL)),
                "description": desc,
                "part_no": part,
                "selling_inr": as_price(cell(r, C_SELL)),
            })
    return rows, used


# ---------- 3. Encrypt ----------
def derive_key(password, salt):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    return kdf.derive(password.encode("utf-8"))


def b64(b):
    return base64.b64encode(b).decode("ascii")


def encrypt(payload, password, salt):
    iv = os.urandom(12)
    plain = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(derive_key(password, salt)).encrypt(iv, plain, None)
    return {"v": 1, "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def decrypt(blob, password):
    try:
        salt, iv, ct = (base64.b64decode(blob[k]) for k in ("salt", "iv", "ct"))
        plain = AESGCM(derive_key(password, salt)).decrypt(iv, ct, None)
        return json.loads(plain)
    except Exception:
        return None  # first run, or the password changed


# ---------- main ----------
def main(reader=read_sheet):
    key_json = secret("GOOGLE_SA_KEY")
    sheet_id = secret("SHEET_ID")
    password = secret("SITE_PASSWORD")
    salt = secret("SITE_SALT").encode("utf-8")
    if len(password) < 12:
        stop("SITE_PASSWORD must be at least 12 characters")

    rows, used = build_rows(reader(sheet_id, key_json))
    if used == 0:
        stop("no tab has the 10 standard headers in row 1")
    if not rows:
        stop("the price tabs have no parts")

    previous = None
    if DATA_FILE.exists():
        try:
            previous = decrypt(json.loads(DATA_FILE.read_text("utf-8")), password)
        except ValueError:
            previous = None
    if previous and len(rows) < len(previous.get("rows", [])) / 2:
        stop(f"the number of parts fell from {len(previous['rows'])} to {len(rows)} - check the sheet")

    prices_changed = previous is None or previous.get("rows") != rows
    if prices_changed:
        payload = {"updated": dt.datetime.now(IST).isoformat(timespec="minutes"), "rows": rows}
        DATA_FILE.write_text(json.dumps(encrypt(payload, password, salt)) + "\n", "utf-8")

    # Monthly heartbeat keeps GitHub's 60-day schedule rule from switching the robot off.
    month = dt.datetime.now(IST).strftime("%Y-%m")
    old_month = HEARTBEAT_FILE.read_text("utf-8").strip() if HEARTBEAT_FILE.exists() else ""
    heartbeat_changed = month != old_month
    if heartbeat_changed:
        HEARTBEAT_FILE.write_text(month + "\n", "utf-8")

    priced = sum(1 for r in rows if r["selling_inr"] is not None)
    print(f"Price tabs read: {used} | parts: {len(rows)} | with price: {priced} | "
          f"on request: {len(rows) - priced} | prices changed: {'yes' if prices_changed else 'no'}")

    changed = prices_changed or heartbeat_changed
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")


if __name__ == "__main__":
    main()
