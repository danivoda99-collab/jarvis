import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { ARGUS_SYSTEM, ARGUS_TOOLS, SPOKEN_ROMANIAN } from "@/lib/argus";
import { memoryPrompt } from "@/lib/memorie";

// Un pas din conversație: aplicația trimite istoricul, Claude răspunde cu text sau cu unelte de rulat.
// Cheia API rămâne pe server; uneltele rulează în browser, ca să poată arăta ferestre și cere confirmări.

const MODEL = process.env.ARGUS_MODEL || "claude-sonnet-5-5";
const MAX_HISTORY = 60;

function errorMessage(caught: unknown) {
  if (caught instanceof Anthropic.AuthenticationError) return "Cheia Anthropic nu e validă. Verific-o în Vercel.";
  if (caught instanceof Anthropic.RateLimitError) return "Prea multe cereri sau limita lunară atinsă. Mai încearcă puțin mai târziu.";
  if (caught instanceof Anthropic.APIError) return `Claude a răspuns cu eroare ${caught.status ?? ""}.`.trim();
  return "Nu pot ajunge la Claude.";
}

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
  let wantsStream = false;
  try {
    const body = (await request.json()) as { messages?: Anthropic.Beta.BetaMessageParam[]; limba?: string; flux?: boolean };
    messages = Array.isArray(body.messages) ? body.messages : [];
    romanian = body.limba === "ro";
    wantsStream = body.flux === true;
  } catch {
    return NextResponse.json({ error: "Cerere invalidă." }, { status: 400 });
  }
  if (messages.length === 0 || messages.length > MAX_HISTORY * 2) {
    return NextResponse.json({ error: "Conversație invalidă." }, { status: 400 });
  }

  const client = new Anthropic();
  // Faptele ținute minte vin la final, ca restul instrucțiunilor să rămână în cache.
  const memory = await memoryPrompt();
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: 4000,
      system: (romanian ? ARGUS_SYSTEM + SPOKEN_ROMANIAN : ARGUS_SYSTEM) + memory,
      tools: ARGUS_TOOLS,
      messages,
      // Răspunsuri vocale scurte: gândire puțină, ca să vină repede.
      output_config: { effort: "low" as const },
      cache_control: { type: "ephemeral" as const },
      ...(MODEL.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
  };

  // Răspunsul vine pe bucăți (o linie JSON pe eveniment), ca telefonul să înceapă să vorbească imediat.
  if (wantsStream) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        try {
          const stream = client.beta.messages.stream(params);
          stream.on("text", (delta) => send({ t: "d", d: delta }));
          const message = await stream.finalMessage();
          send({ t: "end", content: message.content, stop_reason: message.stop_reason });
        } catch (caught) {
          send({ t: "err", error: errorMessage(caught) });
        }
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  }

  try {
    const response = await client.beta.messages.create(params);
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
