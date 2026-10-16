import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { knownNames } from "@/lib/memorie";
import { STT_MODEL, openaiError, openaiKey } from "@/lib/openai";

// Primește înregistrarea a ce a spus Daniel și o transformă în text românesc.
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const key = openaiKey();
  if (!key) return NextResponse.json({ error: "Lipsește cheia OPENAI_API_KEY în Vercel." }, { status: 501 });

  let audio: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("audio");
    audio = value instanceof File ? value : null;
  } catch {
    audio = null;
  }
  if (!audio || audio.size === 0) return NextResponse.json({ error: "Nu am primit sunet." }, { status: 400 });
  if (audio.size > MAX_BYTES) return NextResponse.json({ error: "Înregistrarea e prea lungă." }, { status: 413 });

  const upstream = new FormData();
  upstream.set("file", audio, audio.name || "voce.webm");
  upstream.set("model", STT_MODEL);
  upstream.set("language", "ro");
  // Cuvintele pe care Daniel le spune des, ca să fie scrise corect.
  // Plus numele oamenilor din memorie, ca „Dolgae” să nu devină „Dolgaie”.
  const names = await knownNames();
  upstream.set(
    "prompt",
    `Argus, accept. Argus, refuz. Agenda, to-do, buget, OVB, Alba Iulia, București.${names.length ? ` ${names.join(", ")}.` : ""}`,
  );
  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: upstream,
    });
    if (!response.ok) return NextResponse.json({ error: openaiError(response.status) }, { status: 502 });
    const data = (await response.json()) as { text?: string };
    return NextResponse.json({ text: (data.text ?? "").trim() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Nu pot ajunge la OpenAI." }, { status: 502 });
  }
}
