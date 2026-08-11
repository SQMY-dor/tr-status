// 本地模拟 /api/status 接口 + 静态文件服务, 用于前端渲染测试
const http = require("http");
const fs = require("fs");
const path = require("path");

const PAGES = path.join(__dirname, "../pages/public");

// 构造 2 天的 5 分钟 slot 数据 (部分正常/降级/中断, 部分无数据)
function genSlots(days) {
  const slots = {};
  const models = ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "glm-5.1", "kimi-k2.7-code", "@api"];
  for (let d = 0; d < days; d++) {
    const dt = new Date(Date.UTC(2026, 7, 12 - d));
    const dk = dt.toISOString().slice(0, 10);
    const day = {};
    for (let m = 0; m < 288; m++) {
      const hm = String(Math.floor(m / 12)).padStart(2, "0") + ":" + String((m % 12) * 5).padStart(2, "0");
      const entry = {};
      for (const [i, model] of models.entries()) {
        // 制造一些故障模式
        let s = "up", ttfb = 200 + i * 50 + Math.floor(Math.random() * 300);
        if (model === "deepseek-v4-pro" && d === 0 && m >= 120 && m < 130) { s = "down"; ttfb = null; }
        else if (model === "deepseek-v4-pro" && d === 1 && m >= 200 && m < 210) { s = "degraded"; ttfb = 12000; }
        else if (model === "glm-5.2" && m >= 240 && m < 245) { s = "degraded"; ttfb = 11000; }
        else if (model === "kimi-k2.7-code" && d === 1 && m >= 60 && m < 70) { s = "down"; ttfb = null; }
        // 随机留一些空档 (无数据)
        if (Math.random() < 0.02) continue;
        entry[model] = { s, ttfb, err: s === "down" ? "HTTP 500: internal error" : null };
      }
      day[hm] = entry;
    }
    slots[dk] = day;
  }
  return slots;
}

// 构造 90 天按天聚合 (兼容旧结构)
function genHistory() {
  const days = {};
  const models = ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "glm-5.1", "kimi-k2.7-code"];
  for (let d = 89; d >= 0; d--) {
    const dt = new Date(Date.UTC(2026, 4, 15 + (89 - d))); // 从 5/15 开始
    const dk = dt.toISOString().slice(0, 10);
    const day = {};
    for (const model of models) {
      const t = 288;
      let ok = t;
      if (model === "deepseek-v4-pro" && d < 3) ok = t - 8;
      if (model === "glm-5.2" && d === 40) ok = t - 30;
      day[model] = { ok, t, lat: 250000, mn: 80, mx: 15000 };
    }
    days[dk] = day;
  }
  return { days, updated_at: Math.floor(Date.now() / 1000) };
}

function genLatest() {
  return {
    checked_at: Math.floor(Date.now() / 1000),
    overall: "operational",
    model_count: 5,
    models: {
      "@api": { model: "@api", status: "up", http: 200, ttfb: 180, total: 220, error: null, checked_at: Math.floor(Date.now() / 1000) },
      "deepseek-v4-flash": { model: "deepseek-v4-flash", status: "up", http: 200, ttfb: 240, total: 290, error: null, checked_at: Math.floor(Date.now() / 1000) },
      "deepseek-v4-pro": { model: "deepseek-v4-pro", status: "up", http: 200, ttfb: 380, total: 420, error: null, checked_at: Math.floor(Date.now() / 1000) },
      "glm-5.2": { model: "glm-5.2", status: "up", http: 200, ttfb: 310, total: 350, error: null, checked_at: Math.floor(Date.now() / 1000) },
      "glm-5.1": { model: "glm-5.1", status: "up", http: 200, ttfb: 290, total: 330, error: null, checked_at: Math.floor(Date.now() / 1000) },
      "kimi-k2.7-code": { model: "kimi-k2.7-code", status: "up", http: 200, ttfb: 350, total: 400, error: null, checked_at: Math.floor(Date.now() / 1000) },
    },
  };
}

const slots = genSlots(2);
const history = genHistory();
const latest = genLatest();
const incidents = {
  events: [
    { id: "deepseek-v4-pro-1", model: "deepseek-v4-pro", started_at: Math.floor(Date.now() / 1000) - 3600, resolved_at: Math.floor(Date.now() / 1000) - 3000, title: "deepseek-v4-pro 服务中断", detail: "HTTP 500" },
    { id: "kimi-k2.7-code-1", model: "kimi-k2.7-code", started_at: Math.floor(Date.now() / 1000) - 7200, resolved_at: null, title: "kimi-k2.7-code 服务中断", detail: "timeout after 45000ms" },
  ],
};

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/status")) {
    const url = new URL(req.url, "http://localhost");
    const range = url.searchParams.get("range") || "24h";
    const data = { latest, history, incidents, catalog: { models: {
      "deepseek-v4-flash": { context_length: 131072, input_price: 1, output_price: 2 },
      "deepseek-v4-pro": { context_length: 131072, input_price: 4, output_price: 8 },
      "glm-5.2": { context_length: 262144, input_price: 2, output_price: 6 },
      "glm-5.1": { context_length: 262144, input_price: 2, output_price: 6 },
      "kimi-k2.7-code": { context_length: 262144, input_price: 2, output_price: 8 },
    } }, slots: range === "90d" ? {} : slots, range };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(data));
  }
  // 静态文件
  let fp = path.join(PAGES, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
  const ext = path.extname(fp);
  const ct = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[ext] || "application/octet-stream";
  res.setHeader("Content-Type", ct + "; charset=utf-8");
  res.end(fs.readFileSync(fp));
});

server.listen(8899, () => console.log("mock status server: http://localhost:8899"));
