// SolarX by Osman — Cloudflare Worker
// Replaces the GitHub Actions + cron-job.org setup. Runs on Cloudflare's
// own free Cron Triggers (no "Actions minutes" limit).
//
// SETUP (all done in the Cloudflare dashboard, no CLI needed):
// 1. Create a KV namespace (Workers & Pages -> KV -> Create) named e.g. SOLARX_KV
// 2. Create a Worker (Workers & Pages -> Create -> Worker), paste this whole
//    file into the Quick Edit code box.
// 3. Worker -> Settings -> Variables:
//      - Bind the KV namespace: variable name "SOLARX_KV" -> your namespace
//      - Add these as Secret (encrypted) text variables:
//        SM_USER, SM_PASS, SM_COMPANY_KEY, SM_PN, SM_SN, NTFY_TOPIC,
//        TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_DEVICE_ID, TUYA_ENDPOINT
//      (SM_DEVCODE/SM_DEVADDR are optional, default to 2449 / 1 below)
// 4. Worker -> Settings -> Triggers -> Cron Triggers -> Add:  */1 * * * *
// 5. Save & Deploy. Your worker URL will look like:
//      https://solarx-monitor.<your-subdomain>.workers.dev
//    The PWA reads live data from:  <that-url>/status

const API_HOST = "http://android.shinemonitor.com/public/";
const APP_SUFFIX =
  "&i18n=en_US&lang=en_US&source=1" +
  "&_app_client_=android" +
  "&_app_id_=wifiapp.volfw.watchpower" +
  "&_app_version_=1.7.1.0";

// ---------- hashing helpers ----------
async function sha1Hex(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256Hex(key, msg) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// ---------- ShineMonitor (WatchPower) API ----------
async function apiCall(actionStr, salt, sign, token) {
  let url = `${API_HOST}?sign=${sign}&salt=${salt}`;
  if (token) url += `&token=${token}`;
  url += actionStr;
  const res = await fetch(url);
  return await res.json();
}

async function auth(usr, pwd, companyKey) {
  const salt = Date.now().toString();
  const action =
    "&action=authSource&usr=" + encodeURIComponent(usr) + "&company-key=" + companyKey + APP_SUFFIX;
  const pwdHash = await sha1Hex(pwd);
  const sign = await sha1Hex(salt + pwdHash + action);
  const result = await apiCall(action, salt, sign);
  if (result.err !== 0) throw new Error("Auth failed: " + JSON.stringify(result));
  return { secret: result.dat.secret, token: result.dat.token };
}

async function queryDeviceLastData(secret, token, pn, sn, devcode, devaddr) {
  const salt = Date.now().toString();
  const action =
    "&action=querySPDeviceLastData&pn=" + pn + "&devcode=" + devcode + "&devaddr=" + devaddr + "&sn=" + sn + APP_SUFFIX;
  const sign = await sha1Hex(salt + secret + token + action);
  const result = await apiCall(action, salt, sign, token);
  if (result.err !== 0) throw new Error("Query failed: " + JSON.stringify(result));
  return result.dat;
}

async function queryDeviceFlowPower(secret, token, pn, sn, devcode, devaddr) {
  const salt = Date.now().toString();
  const action =
    "&action=queryDeviceFlowPower&pn=" + pn + "&sn=" + sn + "&devaddr=" + devaddr + "&devcode=" + devcode + APP_SUFFIX;
  const sign = await sha1Hex(salt + secret + token + action);
  const result = await apiCall(action, salt, sign, token);
  if (result.err !== 0) throw new Error("FlowPower query failed: " + JSON.stringify(result));
  return result.dat;
}

function flattenReading(dat) {
  if (!dat) return {};
  // format A: { pars: { gd_: [{id,par,val,unit}], bt_: [...], bc_: [...] , ... } }
  if (dat.pars && typeof dat.pars === "object") {
    const reading = {};
    for (const cat of Object.values(dat.pars)) {
      if (!Array.isArray(cat)) continue;
      for (const item of cat) {
        if (item && item.par) {
          reading[item.par] = item.unit ? `${item.val} ${item.unit}` : String(item.val);
        }
      }
    }
    return reading;
  }
  // format B: { title: [{title}], row: [{field: [...]}] }
  if (dat.title && dat.row) {
    const titles = (dat.title || []).map((t) => t.title || "");
    const rows = dat.row || [];
    if (!rows.length) return {};
    const fields = rows[0].field || [];
    const reading = {};
    titles.forEach((title, i) => {
      if (i < fields.length) reading[title] = fields[i];
    });
    return reading;
  }
  return {};
}

function findField(reading, keywords) {
  for (const [title, value] of Object.entries(reading)) {
    const low = title.toLowerCase();
    for (const kw of keywords) {
      if (low.includes(kw)) return [title, value];
    }
  }
  return [null, null];
}

// ---------- ntfy ----------
async function sendNtfy(topic, title, message) {
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: "zap", "Content-Type": "text/plain; charset=utf-8" },
      body: message,
    });
  } catch (e) {
    console.log("ntfy send failed:", e.message);
  }
}

// ---------- Tuya Cloud API ----------
async function tuyaRequest(endpoint, method, path, bodyObj, accessId, accessSecret, accessToken) {
  const t = Date.now().toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const bodyHash = await sha256Hex(bodyStr);
  const stringToSign = `${method}\n${bodyHash}\n\n${path}`;
  const signStr = accessId + (accessToken || "") + t + stringToSign;
  const sign = await hmacSha256Hex(accessSecret, signStr);
  const headers = { client_id: accessId, sign, t, sign_method: "HMAC-SHA256" };
  if (accessToken) headers.access_token = accessToken;
  if (bodyObj) headers["Content-Type"] = "application/json";
  const res = await fetch(endpoint + path, { method, headers, body: bodyObj ? bodyStr : undefined });
  return await res.json();
}

async function controlTuyaSwitch(env, turnOn) {
  const { TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_DEVICE_ID } = env;
  const endpoint = env.TUYA_ENDPOINT || "https://openapi.tuyaeu.com";
  if (!TUYA_ACCESS_ID || !TUYA_ACCESS_SECRET || !TUYA_DEVICE_ID) {
    console.log("Tuya not configured - skipping.");
    return;
  }
  try {
    const tokenRes = await tuyaRequest(endpoint, "GET", "/v1.0/token?grant_type=1", null, TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, null);
    if (!tokenRes.success) throw new Error("token fetch failed: " + JSON.stringify(tokenRes));
    const accessToken = tokenRes.result.access_token;

    let switchCode = "switch_1";
    try {
      const statusRes = await tuyaRequest(
        endpoint, "GET", `/v1.0/iot-03/devices/${TUYA_DEVICE_ID}/status`, null,
        TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, accessToken
      );
      const codes = (statusRes.result || []).map((d) => d.code);
      for (const c of ["switch_1", "switch", "switch_led"]) {
        if (codes.includes(c)) { switchCode = c; break; }
      }
    } catch (e) {}

    const cmdRes = await tuyaRequest(
      endpoint, "POST", `/v1.0/iot-03/devices/${TUYA_DEVICE_ID}/commands`,
      { commands: [{ code: switchCode, value: turnOn }] },
      TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, accessToken
    );
    console.log(`Tuya switch -> ${turnOn ? "ON" : "OFF"}:`, JSON.stringify(cmdRes));
  } catch (e) {
    console.log("Tuya control failed:", e.message);
  }
}

// ---------- main monitor run ----------
async function runMonitor(env) {
  const devcode = env.SM_DEVCODE || "2449";
  const devaddr = env.SM_DEVADDR || "1";

  let reading = {};
  let rawSnapshot = null;
  try {
    const { secret, token } = await auth(env.SM_USER, env.SM_PASS, env.SM_COMPANY_KEY);
    const dat = await queryDeviceLastData(secret, token, env.SM_PN, env.SM_SN, devcode, devaddr);
    rawSnapshot = dat;
    reading = flattenReading(dat);

    let flowDatRaw = null;
    try {
      const flowDat = await queryDeviceFlowPower(secret, token, env.SM_PN, env.SM_SN, devcode, devaddr);
      flowDatRaw = flowDat;
      const flowReading = flattenReading(flowDat);
      reading = { ...reading, ...flowReading };
    } catch (e) {
      console.log("WARN flow-power query failed:", e.message);
    }
  } catch (e) {
    console.log("ERROR fetching data:", e.message);
    return;
  }

  console.log("DEBUG reading keys:", JSON.stringify(Object.keys(reading)));

  const [modeTitle, modeVal] = findField(reading, ["mode", "work mode", "operation"]);
  const [battTitle, battVal] = findField(reading, ["battery capacity", "soc", "battery %"]);

  const prev = (await env.SOLARX_KV.get("status", { type: "json" })) || {};
  const prevMode = prev.mode_value;
  const changed = modeVal && prevMode && modeVal !== prevMode;

  const newState = {
    updated_at: new Date().toISOString().replace("T", " ").substring(0, 19),
    mode_title: modeTitle,
    mode_value: modeVal,
    battery_title: battTitle,
    battery_value: battVal,
    reading,
    debug_raw_snapshot: reading && Object.keys(reading).length ? undefined : rawSnapshot,
  };
  await env.SOLARX_KV.put("status", JSON.stringify(newState));

  if (changed) {
    await sendNtfy(
      env.NTFY_TOPIC,
      "SolarX - Mode Changed",
      `${prevMode} -> ${modeVal}` + (battVal ? `\nBattery: ${battVal}` : "")
    );
    const m = (modeVal || "").toLowerCase();
    if (m.includes("batt")) await controlTuyaSwitch(env, false);
    else if (m.includes("line") || m.includes("grid")) await controlTuyaSwitch(env, true);
    console.log(`Notified: ${prevMode} -> ${modeVal}`);
  } else {
    console.log(`No change. mode=${modeVal} battery=${battVal}`);
  }
}

// ---------- worker entry points ----------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/status") {
      const data = (await env.SOLARX_KV.get("status", { type: "json" })) || {
        updated_at: null, mode_title: null, mode_value: null,
        battery_title: null, battery_value: null, reading: {},
      };
      return new Response(JSON.stringify(data), { headers: corsHeaders() });
    }

    if (url.pathname === "/run") {
      await runMonitor(env);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    return new Response("SolarX worker is running. Use /status or /run.", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  },
};
