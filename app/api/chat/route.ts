import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { ARGUS_SYSTEM, ARGUS_TOOLS, SPOKEN_ROMANIAN } from "@/lib/argus";

// Un pas din conversație: aplicația trimite istoricul, Claude răspunde cu text sau cu unelte de rulat.
// Cheia API rămâne pe server; uneltele rulează în browser, ca să poată arăta ferestre și cere confirmări.

const MODEL = process.env.ARGUS_MODEL || "claude-sonnet-5-5";
const MAX_HISTORY = 60;

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Lipsește cheia ANTHROPIC_API_KEY în Vercel. Pune-o la Environment Variables și fă Redeploy." },
      { status: 500 },
    );
  }

  let messages: Anthropic.Beta.BetaMessageParam[];
  let romanian = false;
  try {
    const body = (await request.json()) as { messages?: Anthropic.Beta.BetaMessageParam[]; limba?: string };
    messages = Array.isArray(body.messages) ? body.messages : [];
    romanian = body.limba === "ro";
  } catch {
    return NextResponse.json({ error: "Cerere invalidă." }, { status: 400 });
  }
  if (messages.length === 0 || messages.length > MAX_HISTORY * 2) {
    return NextResponse.json({ error: "Conversație invalidă." }, { status: 400 });
  }

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: romanian ? ARGUS_SYSTEM + SPOKEN_ROMANIAN : ARGUS_SYSTEM,
      tools: ARGUS_TOOLS,
      messages,
      // Răspunsuri vocale scurte: gândire puțină, ca să vină repede.
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
      ...(MODEL.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    return NextResponse.json(
      { content: response.content, stop_reason: response.stop_reason },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (caught) {
    if (caught instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: "Cheia Anthropic nu e validă. Verific-o în Vercel." }, { status: 502 });
    }
    if (caught instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Prea multe cereri sau limita lunară atinsă. Mai încearcă puțin mai târziu." }, { status: 429 });
    }
    if (caught instanceof Anthropic.APIError) {
      return NextResponse.json({ error: `Claude a răspuns cu eroare ${caught.status ?? ""}.`.trim() }, { status: 502 });
    }
    return NextResponse.json({ error: "Nu pot ajunge la Claude." }, { status: 502 });
  }
}
