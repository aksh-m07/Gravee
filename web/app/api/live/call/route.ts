/** The phone reply page polls this for the screenshot and the conversation so far. Local only, like the rest of live mode. */
export async function GET(req: Request) {
  if (process.env.VERCEL) return Response.json({ error: "Live mode runs on your own computer only." }, { status: 501 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Bad request" }, { status: 400 });
  const { getCall } = await import("@/sandbox/live");
  const call = getCall(id);
  if (!call) return Response.json({ error: "No such call." }, { status: 404 });
  return Response.json(call, { headers: { "Cache-Control": "no-store" } });
}
