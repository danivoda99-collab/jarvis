import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";

// Cere la ElevenLabs un token de conversație valabil scurt timp.
// Cheia API rămâne pe server; telefonul primește doar tokenul.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) {
    return NextResponse.json({ error: "Serverul nu e configurat." }, { status: 500 });
  }

  const url = `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { "xi-api-key": apiKey },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "Nu pot ajunge la ElevenLabs." }, { status: 502 });
  }

  if (!upstream.ok) {
    return NextResponse.json(
      { error: `ElevenLabs a răspuns cu ${upstream.status}.` },
      { status: 502 },
    );
  }

  const { token } = (await upstream.json()) as { token?: string };
  if (!token) {
    return NextResponse.json({ error: "ElevenLabs nu a trimis token." }, { status: 502 });
  }
  return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
