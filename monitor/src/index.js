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
// KV 写入经济模式：latest 仅在状态变化时重写，否则按心跳间隔刷新时间戳/TTFB
const LATEST_HEARTBEAT_MS = 15 * 60 * 1000;

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

// ---------- hourly history aggregation (KV key: history) ----------
// 无状态方案：每小时首轮从 slot: 明细键重算「今天 + 昨天」的日级聚合后合并写回。
// 数据源就是格子图 slot 键 → isolate 重启/内存丢失都不会产生数据漂移，
// 也无需额外 meta 键。同时重算昨天是为了覆盖跨日边界（23:05 后的尾部样本）。
// 写入：~24 次/天（原先 288 次/天）。

async function rebuildDayFromSlots(kv, dk) {
  const slots = (await kv.get("slot:" + dk, "json").catch(() => null)) || {};
  const day = {};
  for (const hm of Object.keys(slots)) {
    for (const [model, e] of Object.entries(slots[hm])) {
      if (model === "@api") continue; // API endpoint probe 不计入模型统计
      const d = day[model] || { ok: 0, t: 0, lat: 0, mn: null, mx: null };
      d.t += 1;
      if (e.s !== "down") {
        d.ok += 1;
        if (e.ttfb != null) {
          d.lat += e.ttfb;
          d.mn = d.mn == null ? e.ttfb : Math.min(d.mn, e.ttfb);
          d.mx = d.mx == null ? e.ttfb : Math.max(d.mx, e.ttfb);
        }
      }
      day[model] = d;
    }
  }
  return day;
}

async function flushHistory(kv, now) {
  let hist = { days: {} };
  try {
    const raw = await kv.get("history", "json");
    if (raw && raw.days) hist = raw;
  } catch (_) {}

  // 幂等闸门：本小时内已 flush 过则跳过（重复调用零写入）
  const hourBucket = Math.floor(now / (3600 * 1000));
  if ((hist._last_hour_bucket ?? 0) >= hourBucket) return false;

  // 重算今天 + 昨天（昨天的尾部样本只在次日凌晨的 flush 中补齐）
  hist.days[dayKey(now)] = await rebuildDayFromSlots(kv, dayKey(now));
  hist.days[dayKey(now - 86400 * 1000)] = await rebuildDayFromSlots(kv, dayKey(now - 86400 * 1000));

  // prune old days
  const cutoff = dayKey(now - HISTORY_DAYS * 86400 * 1000);
  for (const k of Object.keys(hist.days)) if (k < cutoff) delete hist.days[k];
  hist.updated_at = Math.floor(now / 1000);
  hist._last_hour_bucket = hourBucket;

  await kv.put("history", JSON.stringify(hist));
  // slot 清理也挂到每小时 flush 里（原先是每轮执行）
  await cleanupSlots(kv);
  return true;
}

// ---------- incidents（事件驱动写入）----------
// 上游状态对比源：KV 里的 latest.models[*].status（取代旧的独立 state 键）。
// 只有 up/degraded ↔ down 翻转时才写 incidents；稳定期该键零写入。
// 返回值：本次是否发生了写入。

async function updateIncidents(kv, results, now, prevState) {
  const ts = Math.floor(now / 1000);

  let inc = { events: [] };
  try { inc = (await kv.get("incidents", "json")) || { events: [] }; } catch (_) {}
  if (!inc.events) inc.events = [];

  let changed = false;
  for (const r of results) {
    const prev = prevState[r.model];
    if (prev && prev.status !== "down" && r.status === "down") {
      // open incident
      inc.events.unshift({
        id: r.model + "-" + ts, model: r.model, started_at: ts, resolved_at: null,
        title: r.model + " 服务中断", detail: r.error || "unknown error",
      });
      changed = true;
    } else if (prev && prev.status === "down" && r.status !== "down") {
      // resolve the newest open incident for this model
      const open = inc.events.find(e => e.model === r.model && e.resolved_at === null);
      if (open) { open.resolved_at = ts; changed = true; }
    } else if (!prev && r.status === "down") {
      // 首次观测即 down（如刚上线/数据被清），也开单，避免漏报长故障
      inc.events.unshift({
        id: r.model + "-" + ts, model: r.model, started_at: ts, resolved_at: null,
        title: r.model + " 服务中断", detail: r.error || "unknown error",
      });
      changed = true;
    }
  }

  if (!changed) return false; // 无事件 → 零写入
  inc.events = inc.events.slice(0, 100);
  await kv.put("incidents", JSON.stringify(inc));
  return true;
}

// ---------- entry ----------

// 状态签名：所有模型（含 @api）的状态序列化。签名相同 ⇒ 前端展示无任何变化，
// 无需重写 latest。TTFB 数值变化不触发写入，由心跳机制兜底刷新。
function statusSignature(summary) {
  return JSON.stringify(
    Object.keys(summary.models).sort().map(m => [m, summary.models[m].status])
  );
}

// ---------- 受限并发探测 ----------
// 22 个模型瞬时并发会触发上游风控(403 冻结)。改为:
//   - 最多 MAX_PROBE_CONCURRENCY 个并发
//   - 每个请求前随机等待 0 ~ PROBE_JITTER_MAX_MS
// 让 22 个请求在 5 分钟窗口内随机错开, 既保格子图精度又不触发风控。
const MAX_PROBE_CONCURRENCY = 3;
const PROBE_JITTER_MAX_MS = 20000;

function jitterDelay() {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * PROBE_JITTER_MAX_MS));
}

async function probeAllModelIds(modelIds, apiKey) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < modelIds.length) {
      const m = modelIds[cursor++];
      await jitterDelay(); // 随机错开, 避免同时打上游
      try {
        results.push(await probeModel(m, apiKey));
      } catch (e) {
        results.push({ model: m, status: "down", http: 0, ttfb: null, total: 0, error: "probe crashed: " + String(e.message || e).slice(0, 120), error_kind: "probe_error", checked_at: Math.floor(Date.now() / 1000) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PROBE_CONCURRENCY, modelIds.length) }, worker));
  return results;
}

async function runProbe(env) {
  const apiKey = env.TR_API_KEY;
  if (!apiKey) return { error: "TR_API_KEY secret not set" };
  const catalog = await syncCatalog(env, apiKey);
  const modelIds = Object.keys(catalog.models || {}).length
    ? Object.keys(catalog.models)
    : FALLBACK_MODELS;
  const apiProbe = await probeEndpoint(apiKey);
  const results = await probeAllModelIds(modelIds, apiKey);
  results.push(apiProbe);
  const now = Date.now();
  const summary = {
    checked_at: Math.floor(now / 1000),
    overall: overallStatus(results),
    model_count: modelIds.length,
    models: Object.fromEntries(results.map(r => [r.model, r])),
  };

  // --- KV 写入经济模式 ---
  // 每轮固定写：slot:<date>（格子图，不可省）。
  // 条件写：latest（状态签名变化 或 超过15min心跳）、history+slot清理(每小时首轮)、
  //         incidents(仅 up/down 翻转事件)。
  // 稳定无故障时每轮写入 ≈1 次，全天 ~350 次 vs 原 1440 次。
  const oldLatest = await env.tr_status.get("latest", "json").catch(() => null);

  const newSig = statusSignature(summary);
  const oldSig = oldLatest ? statusSignature(oldLatest) : null;
  const sigChanged = !oldLatest || newSig !== oldSig;
  const stale = !oldLatest || now - (oldLatest.checked_at || 0) * 1000 >= LATEST_HEARTBEAT_MS;

  // 先落格子（串行），保证随后的整点 flush 读到的 slot 数据包含本轮样本
  await updateSlots(env.tr_status, results, now);

  const jobs = [
    updateIncidents(
      env.tr_status, results, now,
      Object.fromEntries(Object.entries(oldLatest?.models || {}).map(([m, r]) => [m, { status: r.status }]))
    ),
  ];
  if (sigChanged || stale) {
    jobs.push(env.tr_status.put("latest", JSON.stringify(summary)));
  }
  // history flush 每轮都调用：内部有 hourBucket 幂等闸门，非整点首轮零写入，
  // 整点后首轮自动重算并落盘（含 slot 清理）。代价仅是每小时多一次 history 读。
  jobs.push(flushHistory(env.tr_status, now));

  await Promise.all(jobs);
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
