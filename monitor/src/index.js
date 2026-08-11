/**
 * 基元律动 (tokenrhythm.studio) Status Monitor Worker
 * cron: every 5 minutes — probes all models, maintains 90-day history + incidents in KV
 */

const BASE = "https://tokenrhythm.studio";
// fallback only — real list is fetched from /v1/models each run
const FALLBACK_MODELS = [
  "deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4-pro",
  "glm-5", "glm-5.1", "glm-5.2",
  "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code",
  "minimax-m2.5", "minimax-m2.7",
  "mimo-v2.5-pro",
  "qwen3.7-max", "qwen3.8-max",
  "seed-2.1-pro", "seed-2.1-turbo",
];

// ---------- model catalog (auto-synced from /v1/models, TTL 6h) ----------

async function syncCatalog(env, apiKey) {
  let cat = null;
  try { cat = await env.tr_status.get("catalog", "json"); } catch (_) {}
  if (cat && cat.fetched_at && Date.now() - cat.fetched_at < 6 * 3600 * 1000) return cat;
  try {
    const res = await fetch(BASE + "/v1/models", {
      headers: { Authorization: "Bearer " + apiKey },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return cat || { models: {}, fetched_at: 0 };
    const d = await res.json();
    const models = {};
    for (const m of d.data || []) {
      models[m.id] = {
        context_length: m.context_length ?? null,
        max_completion_tokens: m.max_completion_tokens ?? null,
        input_price: m.input_price_per_million ?? null,
        output_price: m.output_price_per_million ?? null,
        supports_vision: !!m.supports_vision,
        supports_tools: !!m.supports_tools,
        supports_reasoning: !!m.supports_reasoning,
      };
    }
    cat = { models, fetched_at: Date.now() };
    await env.tr_status.put("catalog", JSON.stringify(cat));
    return cat;
  } catch (_) {
    return cat || { models: {}, fetched_at: 0 };
  }
}

const PROBE_TIMEOUT_MS = 45000;
const DEGRADED_TTFB_MS = 10000;
const HISTORY_DAYS = 90;

// ---------- probe ----------

async function probeEndpoint(apiKey) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + "/v1/models", {
      headers: { Authorization: "Bearer " + apiKey },
      signal: AbortSignal.timeout(15000),
    });
    const ttfb = Date.now() - t0;
    if (res.ok) {
      return { model: "@api", status: ttfb > DEGRADED_TTFB_MS ? "degraded" : "up", http: 200, ttfb, total: ttfb, error: null, checked_at: Math.floor(Date.now() / 1000) };
    }
    return classify("@api", res.status, "HTTP " + res.status, ttfb, ttfb);
  } catch (e) {
    return classify("@api", 0, String(e.name === "TimeoutError" ? "timeout after 15000ms" : (e.message || e)).slice(0, 120), null, Date.now() - t0);
  }
}

async function probeModel(model, apiKey) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: true,
      }),
    });
    const ttfb = Date.now() - t0;
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const errBody = await res.text();
        const m = errBody.match(/"message"\s*:\s*"([^"]{0,160})/);
        if (m) detail += ": " + m[1];
      } catch (_) {}
      return classify(model, res.status, detail, ttfb, Date.now() - t0);
    }
    // stream: wait for first chunk (TTFB proxy for model responsiveness)
    const reader = res.body.getReader();
    let firstChunkAt = null;
    let sawChoice = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunkAt === null) firstChunkAt = Date.now();
      const txt = new TextDecoder().decode(value);
      if (txt.includes('"choices"') || txt.includes("data: [DONE]")) sawChoice = true;
      if (sawChoice) break;
    }
    try { await reader.cancel(); } catch (_) {}
    const total = Date.now() - t0;
    const ttfbFinal = firstChunkAt ? firstChunkAt - t0 : total;
    if (!sawChoice && ttfbFinal > PROBE_TIMEOUT_MS * 0.9) {
      return classify(model, 200, "no completion chunk", ttfbFinal, total);
    }
    return {
      model, status: ttfbFinal > DEGRADED_TTFB_MS ? "degraded" : "up",
      http: 200, ttfb: ttfbFinal, total, error: null, checked_at: Math.floor(Date.now() / 1000),
    };
  } catch (e) {
    const total = Date.now() - t0;
    if (e.name === "AbortError") return classify(model, 0, "timeout after " + PROBE_TIMEOUT_MS + "ms", null, total);
    return classify(model, 0, "network: " + String(e.message || e).slice(0, 120), null, total);
  } finally {
    clearTimeout(timer);
  }
}

function classify(model, http, detail, ttfb, total) {
  let status = "down";
  let kind = "error";
  if (http === 429) { status = "degraded"; kind = "rate_limited"; }
  else if (http >= 500) kind = "server_error";
  else if (http === 401 || http === 403) kind = "auth_error";
  else if (http === 404) kind = "model_not_found";
  else if (http === 0 && detail.startsWith("timeout")) kind = "timeout";
  else if (http === 0) kind = "network_error";
  else if (http === 200) kind = "incomplete_response";
  else if (http >= 400) kind = "client_error";
  return { model, status, http, ttfb: ttfb ?? null, total, error: detail, error_kind: kind, checked_at: Math.floor(Date.now() / 1000) };
}

// ---------- aggregation ----------

function overallStatus(results) {
  const down = results.filter(r => r.status === "down").length;
  const degraded = results.filter(r => r.status === "degraded").length;
  const n = results.length;
  if (down > n / 2) return "major_outage";
  if (down > 0) return "partial_outage";
  if (degraded > 0) return "degraded_performance";
  return "operational";
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// ---------- 5-minute slot history (KV key: slot:<YYYY-MM-DD>) ----------
// Each cron run (every 5 min) writes one slot for that day. Slots kept SLOT_KEEP_DAYS
// days (fine-grained); older data lives only in the day-aggregated `history` key.

const SLOT_KEEP_DAYS = 7;

function slotTs(now) {
  const d = new Date(now);
  const hm = String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  return { date: d.toISOString().slice(0, 10), hm };
}

async function updateSlots(kv, results, now) {
  const { date, hm } = slotTs(now);
  const key = "slot:" + date;
  let slots = {};
  try { slots = (await kv.get(key, "json")) || {}; } catch (_) {}
  const entry = {};
  for (const r of results) {
    entry[r.model] = {
      s: r.status,                        // up | degraded | down
      ttfb: r.ttfb ?? null,
      err: r.error ? String(r.error).slice(0, 80) : null,
    };
  }
  slots[hm] = entry;
  await kv.put(key, JSON.stringify(slots));
}

async function cleanupSlots(kv) {
  try {
    const cutoff = new Date(Date.now() - (SLOT_KEEP_DAYS + 1) * 86400 * 1000).toISOString().slice(0, 10);
    const list = await kv.list({ prefix: "slot:" });
    for (const k of list.keys) {
      if (k.name.slice(5, 15) < cutoff) await kv.delete(k.name);
    }
  } catch (_) {}
}

async function updateHistory(kv, results, now) {
  let hist = { days: {} };
  try {
    const raw = await kv.get("history", "json");
    if (raw && raw.days) hist = raw;
  } catch (_) {}

  const dk = dayKey(now);
  const day = hist.days[dk] || {};
  for (const r of results) {
    const e = day[r.model] || { ok: 0, t: 0, lat: 0, mn: null, mx: null };
    e.t += 1;
    if (r.status !== "down") {
      e.ok += 1;
      const lat = r.ttfb ?? r.total;
      if (lat != null) {
        e.lat += lat;
        e.mn = e.mn == null ? lat : Math.min(e.mn, lat);
        e.mx = e.mx == null ? lat : Math.max(e.mx, lat);
      }
    }
    day[r.model] = e;
  }
  hist.days[dk] = day;

  // prune old days
  const cutoff = dayKey(now - HISTORY_DAYS * 86400 * 1000);
  for (const k of Object.keys(hist.days)) if (k < cutoff) delete hist.days[k];
  hist.updated_at = Math.floor(now / 1000);
  await kv.put("history", JSON.stringify(hist));
}

async function updateIncidents(kv, results, now) {
  let state = {};
  try { state = (await kv.get("state", "json")) || {}; } catch (_) {}
  let inc = { events: [] };
  try { inc = (await kv.get("incidents", "json")) || { events: [] }; } catch (_) {}

  const ts = Math.floor(now / 1000);
  const newState = {};
  for (const r of results) {
    const prev = state[r.model];
    newState[r.model] = { status: r.status, since: prev && prev.status === r.status ? prev.since : ts, last_error: r.error || null };

    if (prev && prev.status !== "down" && r.status === "down") {
      // open incident
      inc.events.unshift({
        id: r.model + "-" + ts, model: r.model, started_at: ts, resolved_at: null,
        title: r.model + " 服务中断", detail: r.error || "unknown error",
      });
    } else if (prev && prev.status === "down" && r.status !== "down") {
      // resolve the newest open incident for this model
      const open = inc.events.find(e => e.model === r.model && e.resolved_at === null);
      if (open) open.resolved_at = ts;
    }
  }
  inc.events = inc.events.slice(0, 100);
  await kv.put("state", JSON.stringify(newState));
  await kv.put("incidents", JSON.stringify(inc));
  return newState;
}

// ---------- entry ----------

async function runProbe(env) {
  const apiKey = env.TR_API_KEY;
  if (!apiKey) return { error: "TR_API_KEY secret not set" };
  const catalog = await syncCatalog(env, apiKey);
  const modelIds = Object.keys(catalog.models || {}).length
    ? Object.keys(catalog.models)
    : FALLBACK_MODELS;
  const apiProbe = probeEndpoint(apiKey);
  const results = await Promise.all([...modelIds.map(m => probeModel(m, apiKey)), apiProbe]);
  const now = Date.now();
  const summary = {
    checked_at: Math.floor(now / 1000),
    overall: overallStatus(results),
    model_count: modelIds.length,
    models: Object.fromEntries(results.map(r => [r.model, r])),
  };
  await env.tr_status.put("latest", JSON.stringify(summary));
  const historyResults = results.filter(r => r.model !== "@api");
  await updateHistory(env.tr_status, historyResults, now);
  await updateSlots(env.tr_status, results, now);
  await cleanupSlots(env.tr_status);
  await updateIncidents(env.tr_status, results, now);
  return summary;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runProbe(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/probe" && req.method === "POST") {
      if (req.headers.get("x-probe-secret") !== env.PROBE_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const summary = await runProbe(env);
      return Response.json(summary);
    }
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    return new Response("tr-monitor", { status: 200 });
  },
};
