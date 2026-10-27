import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { ELEVEN_VOICES, OPENAI_VOICES, defaultVoice, elevenKey } from "@/lib/openai";

// Spune aplicației dacă vocea și auzul vin de la OpenAI sau din browser.
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const cloud = Boolean(process.env.OPENAI_API_KEY);
  return NextResponse.json(
    { cloud, voci: cloud ? [...(elevenKey() ? Object.keys(ELEVEN_VOICES) : []), ...OPENAI_VOICES] : [], implicita: defaultVoice() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
