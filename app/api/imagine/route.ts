import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { openaiError, openaiKey } from "@/lib/openai";

// O imagine durează între câteva zeci de secunde și peste un minut la modelele noi: lăsăm destul timp.
export const maxDuration = 300;

// OpenAI retrage modelele de imagini des (gpt-image-1 a fost oprit pe 23.10.2026): încercăm pe rând, iar dacă unul
// nu mai există, trecem la următorul. OPENAI_IMAGE_MODEL din Vercel, dacă e pus, vine primul.
const IMAGE_MODELS = [...new Set([process.env.OPENAI_IMAGE_MODEL, "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2"].filter((m): m is string => Boolean(m)))];
const SIZES = { patrat: "1024x1024", portret: "1024x1536", peisaj: "1536x1024" } as const;

// Face o imagine după descrierea lui Daniel și o întoarce ca JPEG (data URL), gata de pus în fereastră.
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const key = openaiKey();
  if (!key) return NextResponse.json({ error: "Lipsește cheia OPENAI_API_KEY în Vercel." }, { status: 501 });

  const body = (await request.json().catch(() => ({}))) as { descriere?: string; format?: string };
  const prompt = (body.descriere ?? "").trim().slice(0, 2000);
  if (!prompt) return NextResponse.json({ error: "Spune-mi ce să fie în imagine." }, { status: 400 });
  const size = SIZES[(body.format as keyof typeof SIZES) ?? "patrat"] ?? SIZES.patrat;

  try {
    let response: Response | null = null;
    let message = "";
    for (const model of IMAGE_MODELS) {
      response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, size, quality: "medium", output_format: "jpeg", output_compression: 85, n: 1 }),
      });
      if (response.ok) break;
      const detail = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
      message = detail?.error?.message ?? "";
      // Modelul nu mai există (sau contul nu-l are): încercăm următorul. Orice altă eroare e reală și o spunem.
      if (!/does not exist|not found|model_not_found|invalid model|unknown model|deprecated|access to model/i.test(`${message} ${detail?.error?.code ?? ""}`)) break;
    }
    if (!response) return NextResponse.json({ error: "Nu e niciun model de imagini setat." }, { status: 500 });
    if (!response.ok) {
      // Refuzurile de conținut le spunem pe nume, ca Argus să poată reformula.
      if (/safety|policy|moderation/i.test(message)) {
        return NextResponse.json({ error: "OpenAI a refuzat imaginea pentru conținut. Reformulează descrierea." }, { status: 400 });
      }
      // Creditul terminat vine de la OpenAI ca 400 („billing_hard_limit_reached”), nu ca 429.
      if (/billing|hard limit|quota|insufficient/i.test(message)) {
        return NextResponse.json({ error: "Creditul OpenAI s-a terminat. Daniel îl reîncarcă pe platform.openai.com, la Billing." }, { status: 402 });
      }
      if (/verif/i.test(message)) {
        return NextResponse.json({ error: "OpenAI cere verificarea organizației pentru imagini (platform.openai.com, Settings, Organization, Verify)." }, { status: 403 });
      }
      return NextResponse.json({ error: `${openaiError(response.status)} ${message.slice(0, 160)}`.trim() }, { status: 502 });
    }
    const data = (await response.json()) as { data?: { b64_json?: string }[] };
    const image = data.data?.[0]?.b64_json;
    if (!image) return NextResponse.json({ error: "OpenAI n-a trimis nicio imagine." }, { status: 502 });
    return NextResponse.json({ imagine: `data:image/jpeg;base64,${image}` }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Nu pot ajunge la OpenAI." }, { status: 502 });
  }
}
