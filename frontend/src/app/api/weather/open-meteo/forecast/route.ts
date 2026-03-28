import { buildProxyUrl, CORS_HEADERS, fetchUpstreamJson } from "../_shared";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request) {
  let upstreamUrl = "";
  try {
    upstreamUrl = buildProxyUrl(request.url, "forecast");
    const upstream = await fetchUpstreamJson(upstreamUrl);
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return Response.json(
      {
        detail: `frontend forecast proxy unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
        upstream: upstreamUrl,
      },
      {
        status: 502,
        headers: CORS_HEADERS,
      },
    );
  }
}
