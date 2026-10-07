import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = process.env.HOROLOG_API_URL ?? "http://localhost:8000";

export async function POST(request: NextRequest) {
  const body = await request.text();

  try {
    const response = await fetch(`${API_BASE}/api/assistant/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(190_000),
    });

    const payload = await response.text();
    return new Response(payload, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown upstream error";

    return Response.json(
      {
        detail:
          "Asystent lokalny nie odpowiedział w wymaganym czasie. " +
          "Spróbuj ponownie po zakończeniu bieżącego generowania. " +
          `Szczegóły: ${message}`,
      },
      { status: 503 },
    );
  }
}
