import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { OPENAI_VOICES, TTS_MODEL, TTS_STYLE, defaultVoice, openaiError, openaiKey } from "@/lib/openai";

// Transformă o frază din răspunsul lui Argus în sunet (mp3).
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const key = openaiKey();
  if (!key) return NextResponse.json({ error: "Lipsește cheia OPENAI_API_KEY în Vercel." }, { status: 501 });

  const body = (await request.json().catch(() => ({}))) as { text?: string; voce?: string };
  const text = (body.text ?? "").trim().slice(0, 1500);
  if (!text) return NextResponse.json({ error: "Nu am primit text." }, { status: 400 });
  const voice = body.voce && OPENAI_VOICES.includes(body.voce) ? body.voce : defaultVoice();

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice, input: text, instructions: TTS_STYLE, response_format: "mp3" }),
    });
    if (!response.ok || !response.body) {
      return NextResponse.json({ error: openaiError(response.status) }, { status: 502 });
    }
    return new Response(response.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Nu pot ajunge la OpenAI." }, { status: 502 });
  }
}
