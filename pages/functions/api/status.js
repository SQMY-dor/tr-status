export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "24h"; // 24h | 7d | 90d

  const [latest, history, incidents, catalog] = await Promise.all([
    env.tr_status.get("latest", "json"),
    env.tr_status.get("history", "json"),
    env.tr_status.get("incidents", "json"),
    env.tr_status.get("catalog", "json"),
  ]);

  // 5-minute slots: fetch day keys covering the requested window
  let slots = {};
  if (range !== "90d") {
    const days = [];
    const now = new Date();
    const n = range === "24h" ? 2 : 7; // today + yesterday (24h spans midnight), or 7 days
    for (let i = 0; i < n; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const vals = await Promise.all(days.map(dk => env.tr_status.get("slot:" + dk, "json").catch(() => null)));
    for (let i = 0; i < days.length; i++) {
      if (vals[i] && Object.keys(vals[i]).length) slots[days[i]] = vals[i];
    }
  }

  // --- 心跳滞后校正（KV 写入经济模式配套）---
  // monitor 的 latest 仅在状态变化或 ≥15min 心跳时重写；期间 checked_at 滞后。
  // 这里用最新 slot 格子的真实探测时间把 checked_at / 各模型时间戳补齐到最新，
  // 前端"X 分钟前更新"无需改动即可显示准确。仅内存校正，零 KV 写入。
  if (latest && latest.checked_at) {
    const slotDays = Object.keys(slots).sort();
    if (slotDays.length) {
      const lastDay = slotDays[slotDays.length - 1];
      const hms = Object.keys(slots[lastDay]).sort();
      if (hms.length) {
        // "HH:MM" → 当天该时刻的 UTC epoch
        const [hh, mm] = hms[hms.length - 1].split(":").map(Number);
        const lastSlotTs = Math.floor(new Date(lastDay + "T00:00:00Z").getTime() / 1000) + hh * 3600 + mm * 60;
        if (lastSlotTs > latest.checked_at) {
          latest.checked_at_prev = latest.checked_at; // 保留原始写入时间，便于调试
          latest.checked_at = lastSlotTs;
          for (const m of Object.keys(latest.models || {})) {
            latest.models[m].checked_at = lastSlotTs;
          }
          if (latest.overall !== undefined && history?.days) {
            /* overall 状态本身来自签名比较，滞后期间必然未变，无需修正 */
          }
        }
      }
    }
  }

  return Response.json({ latest, history, incidents, catalog, slots, range }, {
    headers: {
      "Cache-Control": "public, max-age=20",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
