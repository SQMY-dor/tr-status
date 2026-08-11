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

  return Response.json({ latest, history, incidents, catalog, slots, range }, {
    headers: {
      "Cache-Control": "public, max-age=20",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
