// 本地验证 monitor worker 的 slot 写入/清理逻辑 (从真实源码提取函数)
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../monitor/src/index.js"), "utf8");

// 从源码提取函数定义 (真实代码, 非复刻)
function extract(name) {
  const re = new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, "m");
  const m = src.match(re);
  if (!m) throw new Error("function not found: " + name);
  return m[0];
}
const constRe = (name) => {
  const re = new RegExp(`const ${name} = [^;]+;`, "m");
  const m = src.match(re);
  if (!m) throw new Error("const not found: " + name);
  return m[0];
};

const funcs = [
  extract("slotTs"),
  extract("updateSlots"),
  extract("cleanupSlots"),
  constRe("SLOT_KEEP_DAYS"),
].join("\n");

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(k => ({ name: k })) };
    },
  };
}

const vm = require("vm");
const sandbox = { Date, Math, JSON, Promise, console, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(funcs, sandbox);
sandbox.makeKV = makeKV;

vm.runInContext(`
async function main() {
  const kv = makeKV();
  const t0 = Date.UTC(2026, 7, 12, 7, 0, 0); // 2026-08-12 07:00 UTC

  const models = ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "qwen3.8-max", "@api"];
  const days = [t0, t0 - 86400000, t0 - 2 * 86400000, t0 - 3 * 86400000];
  const mins = [0, 5, 10];
  for (const d of days) {
    for (const m of mins) {
      const now = d + m * 60000;
      const results = models.map((model, i) => ({
        model, status: i === 1 ? "down" : i === 2 ? "degraded" : "up",
        ttfb: i === 1 ? null : 300 + i * 100, error: i === 1 ? "HTTP 500" : null,
      }));
      await updateSlots(kv, results, now);
    }
  }

  console.log("=== KV 中 slot keys ===");
  console.log([...kv.store.keys()].sort().join("\\n"));

  const day1 = await kv.get("slot:2026-08-12", "json");
  console.log("\\n=== 2026-08-12 slot 结构 ===");
  console.log(JSON.stringify(day1, null, 1));

  const count = Object.keys(day1).length;
  console.log("\\nslot 数:", count, count === 3 ? "✅" : "❌ 期望 3");

  // 清理: SLOT_KEEP_DAYS=7; 造一个 10 天前的验证删除
  const old = Date.UTC(2026, 7, 2, 7, 0, 0); // 2026-08-02, 10 天前
  await updateSlots(kv, models.map(m => ({ model: m, status: "up", ttfb: 200, error: null })), old);
  console.log("\\n添加 10 天前 key 后:", [...kv.store.keys()].sort().join(", "));
  await cleanupSlots(kv);
  const after = [...kv.store.keys()].sort();
  console.log("清理后:", after.join(", "));
  console.log("10 天前(08-02)被删:", !after.includes("slot:2026-08-02") ? "✅" : "❌");
  console.log("3 天前(08-09)保留:", after.includes("slot:2026-08-09") ? "✅" : "❌");

  const r = await kv.get("slot:2026-08-12", "json");
  console.log("\\n2026-08-12T07:00 含 @api:", r["07:00"]["@api"] ? "✅" : "❌");
  console.log("示例条目:", JSON.stringify(r["07:00"]["deepseek-v4-flash"]));
  console.log("\\n✅ Worker slot 逻辑验证完成");
}
main().catch(e => { console.error("❌", e); process.exit(1); });
`, sandbox);
