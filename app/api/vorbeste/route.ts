import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { ELEVEN_MODEL, ELEVEN_VOICES, OPENAI_VOICES, TTS_MODEL, TTS_STYLE, TTS_STYLE_RO, defaultVoice, elevenKey, openaiError, openaiKey } from "@/lib/openai";

// Transformă o frază din răspunsul lui Argus în sunet (mp3).
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const key = openaiKey();
  if (!key) return NextResponse.json({ error: "Lipsește cheia OPENAI_API_KEY în Vercel." }, { status: 501 });

  const body = (await request.json().catch(() => ({}))) as { text?: string; voce?: string; limba?: string; format?: string };
  const text = (body.text ?? "").trim().slice(0, 1500);
  if (!text) return NextResponse.json({ error: "Nu am primit text." }, { status: 400 });
  // PCM brut pornește cel mai repede și se poate cânta pe măsură ce vine; mp3 rămâne pentru aplicațiile vechi.
  const pcm = body.format === "pcm";
  // ElevenLabs Flash: pornește foarte repede și sună natural în română. Dacă nu merge, vorbește vocea OpenAI de rezervă.
  const eleven = body.voce ? ELEVEN_VOICES[body.voce] : undefined;
  const elevenApi = elevenKey();
  if (eleven && elevenApi) {
    try {
      const format = pcm ? "pcm_24000" : "mp3_44100_128";
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${eleven}/stream?output_format=${format}`, {
        method: "POST",
        headers: { "xi-api-key": elevenApi, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: ELEVEN_MODEL, language_code: body.limba === "ro" ? "ro" : "en" }),
      });
      if (response.ok && response.body) {
        return new Response(response.body, { headers: { "Content-Type": pcm ? "audio/pcm" : "audio/mpeg", "Cache-Control": "no-store" } });
      }
    } catch {
      // trecem la OpenAI
    }
  }
  const voice = body.voce && OPENAI_VOICES.includes(body.voce) ? body.voce : defaultVoice();

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice, input: text, instructions: body.limba === "ro" ? TTS_STYLE_RO : TTS_STYLE, response_format: pcm ? "pcm" : "mp3" }),
    });
    if (!response.ok || !response.body) {
      return NextResponse.json({ error: openaiError(response.status) }, { status: 502 });
    }
    return new Response(response.body, { headers: { "Content-Type": pcm ? "audio/pcm" : "audio/mpeg", "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Nu pot ajunge la OpenAI." }, { status: 502 });
  }
}
