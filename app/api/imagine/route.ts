import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { openaiError, openaiKey } from "@/lib/openai";

// O imagine durează câteva zeci de secunde la OpenAI.
export const maxDuration = 90;

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
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
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size, quality: "medium", output_format: "jpeg", output_compression: 85, n: 1 }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      const message = detail?.error?.message ?? "";
      // Refuzurile de conținut le spunem pe nume, ca Argus să poată reformula.
      if (/safety|policy|moderation/i.test(message)) {
        return NextResponse.json({ error: "OpenAI a refuzat imaginea pentru conținut. Reformulează descrierea." }, { status: 400 });
      }
      return NextResponse.json({ error: openaiError(response.status) }, { status: 502 });
    }
    const data = (await response.json()) as { data?: { b64_json?: string }[] };
    const image = data.data?.[0]?.b64_json;
    if (!image) return NextResponse.json({ error: "OpenAI n-a trimis nicio imagine." }, { status: 502 });
    return NextResponse.json({ imagine: `data:image/jpeg;base64,${image}` }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Nu pot ajunge la OpenAI." }, { status: 502 });
  }
}
