export async function onRequest({ env }) {
  const [latest, history, incidents, catalog] = await Promise.all([
    env.tr_status.get("latest", "json"),
    env.tr_status.get("history", "json"),
    env.tr_status.get("incidents", "json"),
    env.tr_status.get("catalog", "json"),
  ]);
  return Response.json({ latest, history, incidents, catalog }, {
    headers: {
      "Cache-Control": "public, max-age=20",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
