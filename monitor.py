#!/usr/bin/env python3
"""
SolarX by Osman - ShineMonitor watcher
Polls the ShineMonitor cloud API (used by the WatchPower app) for a single
inverter/device, detects meaningful changes (mode, battery %, etc), sends a
push notification via ntfy.sh, and writes docs/status.json for the PWA.

All secrets are read from environment variables (set as GitHub Actions
secrets) - never hardcode your password in this file.
"""

import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API_HOST = "http://android.shinemonitor.com/public/"

# ---- fixed app-identification suffix (copied from the real WatchPower app) ----
APP_SUFFIX = (
    "&i18n=en_US&lang=en_US&source=1"
    "&_app_client_=android"
    "&_app_id_=wifiapp.volfw.watchpower"
    "&_app_version_=1.7.1.0"
)


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def api_call(params_action_str: str, salt: str, sign: str, token: str = None):
    """params_action_str must start with '&action=...' """
    url = API_HOST + "?sign=" + sign + "&salt=" + salt
    if token:
        url += "&token=" + token
    url += params_action_str
    with urllib.request.urlopen(url, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def auth(usr: str, pwd: str, company_key: str):
    salt = str(int(time.time() * 1000))
    action = (
        "&action=authSource&usr=" + urllib.parse.quote(usr, safe="")
        + "&company-key=" + company_key
        + APP_SUFFIX
    )
    sign = sha1(salt + sha1(pwd) + action)
    result = api_call(action, salt, sign)
    if result.get("err") != 0:
        raise RuntimeError(f"Auth failed: {result}")
    return result["dat"]["secret"], result["dat"]["token"]


def query_device_last_data(secret: str, token: str, pn: str, sn: str, devcode: str, devaddr: str):
    salt = str(int(time.time() * 1000))
    action = (
        "&action=querySPDeviceLastData"
        + "&pn=" + pn
        + "&devcode=" + devcode
        + "&devaddr=" + devaddr
        + "&sn=" + sn
        + APP_SUFFIX
    )
    sign = sha1(salt + secret + token + action)
    result = api_call(action, salt, sign, token)
    if result.get("err") != 0:
        raise RuntimeError(f"Query failed: {result}")
    return result["dat"]


def flatten_reading(dat: dict) -> dict:
    """
    Real ShineMonitor 'querySPDeviceLastData' response shape:
    { "pars": { "gd_": [{id,par,val,unit}, ...], "bt_": [...], "bc_": [...], ... } }
    Flatten every {par: val (+unit)} pair into a single dict, keyed by the
    human-readable 'par' label.
    """
    reading = {}
    pars = dat.get("pars", {})
    for group in pars.values():
        for item in group:
            label = item.get("par", item.get("id", "unknown"))
            val = item.get("val", "")
            unit = item.get("unit", "")
            reading[label] = f"{val} {unit}".strip()
    return reading


def find_field(reading: dict, keywords):
    """Case-insensitive search for a title containing any of the keywords."""
    for title, value in reading.items():
        low = title.lower()
        for kw in keywords:
            if kw in low:
                return title, value
    return None, None


def send_ntfy(topic: str, title: str, message: str, priority: str = "high"):
    url = f"https://ntfy.sh/{topic}"
    req = urllib.request.Request(
        url,
        data=message.encode("utf-8"),
        headers={
            "Title": title.encode("utf-8"),
            "Priority": priority,
            "Tags": "zap",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        print(f"ntfy send failed: {e}", file=sys.stderr)


def main():
    usr = os.environ["SM_USER"]
    pwd = os.environ["SM_PASS"]
    company_key = os.environ["SM_COMPANY_KEY"]
    pn = os.environ["SM_PN"]
    sn = os.environ["SM_SN"]
    devcode = os.environ.get("SM_DEVCODE", "2449")
    devaddr = os.environ.get("SM_DEVADDR", "1")
    ntfy_topic = os.environ["NTFY_TOPIC"]

    state_path = "docs/status.json"

    try:
        secret, token = auth(usr, pwd, company_key)
        dat = query_device_last_data(secret, token, pn, sn, devcode, devaddr)
        reading = flatten_reading(dat)
    except Exception as e:
        print(f"ERROR fetching data: {e}", file=sys.stderr)
        # write the error into status.json too so it's visible without digging through logs
        with open(state_path, "w") as f:
            json.dump({"updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                       "error": str(e)}, f, indent=2, ensure_ascii=False)
        sys.exit(0)

    # DEBUG: always keep the raw server response so we can see exactly what
    # came back if 'reading' ends up empty (field names differ by firmware).
    debug_raw = dat

    # try to find the mode / battery fields (title wording can vary by firmware)
    mode_title, mode_val = find_field(reading, ["mode", "work mode", "operation"])
    batt_title, batt_val = find_field(reading, ["battery capacity", "soc", "battery %"])

    # load previous state
    prev = {}
    if os.path.exists(state_path):
        try:
            with open(state_path) as f:
                prev = json.load(f)
        except Exception:
            prev = {}

    prev_mode = prev.get("mode_value")
    changed = mode_val is not None and prev_mode is not None and mode_val != prev_mode

    new_state = {
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "mode_title": mode_title,
        "mode_value": mode_val,
        "battery_title": batt_title,
        "battery_value": batt_val,
        "reading": reading,
        "debug_raw": debug_raw if not reading else None,
    }

    with open(state_path, "w") as f:
        json.dump(new_state, f, indent=2, ensure_ascii=False)

    if changed:
        send_ntfy(
            ntfy_topic,
            title="SolarX - Mode Changed",
            message=f"{prev_mode} -> {mode_val}"
            + (f"\nBattery: {batt_val}" if batt_val else ""),
        )
        print(f"Notified: {prev_mode} -> {mode_val}")
    else:
        print(f"No change. mode={mode_val} battery={batt_val}")


if __name__ == "__main__":
    main()
