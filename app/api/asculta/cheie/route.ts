import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { knownNames } from "@/lib/memorie";
import { REALTIME_STT_MODEL, openaiError, openaiKey } from "@/lib/openai";

// „Auzul instant”: o cheie de câteva minute cu care telefonul trimite vocea direct la OpenAI, pe măsură ce vorbește Daniel.
// Textul e gata aproape imediat ce tace, fără să mai încarce înregistrarea. Cheia principală rămâne pe server.
export async function POST() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const key = openaiKey();
  if (!key) return NextResponse.json({ error: "Lipsește cheia OPENAI_API_KEY în Vercel." }, { status: 501 });
  const names = await knownNames().catch(() => [] as string[]);
  // OpenAI primește cel mult 1024; numărăm în octeți (diacriticele cântăresc dublu) și lăsăm marjă.
  // Numele intră câte încap, primele fiind cele mai importante.
  const base = "Argus, accept. Argus, refuz. Agenda, to-do, buget, OVB, Alba Iulia, București.";
  const kept: string[] = [];
  for (const name of names) {
    if (Buffer.byteLength(`${base} ${[...kept, name].join(", ")}.`) > 900) break;
    kept.push(name);
  }
  const prompt = kept.length ? `${base} ${kept.join(", ")}.` : base;
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              noise_reduction: { type: "near_field" },
              transcription: { model: REALTIME_STT_MODEL, languages: ["ro"], prompt },
              turn_detection: null,
            },
          },
        },
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { value?: string; expires_at?: number; error?: { message?: string } };
    if (!response.ok || !data.value) {
      // Motivul exact, ca Daniel să mi-l poată spune dacă nu merge.
      const reason = data.error?.message ? `: ${data.error.message.slice(0, 200)}` : "";
      return NextResponse.json({ error: `${openaiError(response.status)}${reason}` }, { status: 502 });
    }
    return NextResponse.json({ cheie: data.value, expira: data.expires_at }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Nu pot ajunge la OpenAI." }, { status: 502 });
  }
}
