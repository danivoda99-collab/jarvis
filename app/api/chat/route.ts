import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { ARGUS_SYSTEM, ARGUS_TOOLS, DRIVING, SPOKEN_ROMANIAN } from "@/lib/argus";
import { memoryPrompt } from "@/lib/memorie";

// Un pas din conversație: aplicația trimite istoricul, Claude răspunde cu text sau cu unelte de rulat.
// Cheia API rămâne pe server; uneltele rulează în browser, ca să poată arăta ferestre și cere confirmări.

const MODEL = process.env.ARGUS_MODEL || "claude-sonnet-5-5";
const MAX_HISTORY = 60;

function errorMessage(caught: unknown) {
  if (caught instanceof Anthropic.AuthenticationError) return "Cheia Anthropic nu e validă. Verific-o în Vercel.";
  if (caught instanceof Anthropic.RateLimitError) return "Prea multe cereri sau limita lunară atinsă. Mai încearcă puțin mai târziu.";
  if (caught instanceof Anthropic.APIError) {
    // Motivul exact (fără date personale), ca o eroare 400 să poată fi reparată din prima.
    const reason = (caught.error as { error?: { message?: string } } | undefined)?.error?.message ?? "";
    return `Claude a răspuns cu eroare ${caught.status ?? ""}${reason ? `: ${reason.slice(0, 200)}` : "."}`;
  }
  return "Nu pot ajunge la Claude.";
}

// Gândirea lui Claude e legată de începutul exact al conversației. Dacă acesta s-a schimbat (o poză scoasă din
// istoric, memoria actualizată), API-ul refuză cu 400; atunci reîncercăm o dată fără blocurile de gândire.
function thinkingRejected(caught: unknown) {
  return caught instanceof Anthropic.BadRequestError && /thinking|signature/i.test(errorMessage(caught));
}

function withoutThinking(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message) =>
    Array.isArray(message.content)
      ? { ...message, content: message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking") }
      : message,
  );
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
  let driving = false;
  let memorySnapshot: string | null = null;
  try {
    const body = (await request.json()) as {
      messages?: Anthropic.Beta.BetaMessageParam[];
      limba?: string;
      flux?: boolean;
      volan?: boolean;
      memorie?: string;
    };
    messages = Array.isArray(body.messages) ? body.messages : [];
    romanian = body.limba === "ro";
    wantsStream = body.flux === true;
    driving = body.volan === true;
    if (typeof body.memorie === "string") memorySnapshot = body.memorie.slice(0, 12_000);
  } catch {
    return NextResponse.json({ error: "Cerere invalidă." }, { status: 400 });
  }
  if (messages.length === 0 || messages.length > MAX_HISTORY * 2) {
    return NextResponse.json({ error: "Conversație invalidă." }, { status: 400 });
  }

  const client = new Anthropic();
  // Faptele ținute minte vin la final, ca restul instrucțiunilor să rămână în cache. Telefonul trimite memoria
  // luată la începutul conversației, ca instrucțiunile să nu se schimbe la mijloc.
  const memory = memorySnapshot ?? (await memoryPrompt());
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: 4000,
      system: (romanian ? ARGUS_SYSTEM + SPOKEN_ROMANIAN : ARGUS_SYSTEM) + (driving ? DRIVING : "") + memory,
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
        let started = false;
        const run = async (request: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
          const stream = client.beta.messages.stream(request);
          stream.on("text", (delta) => {
            started = true;
            send({ t: "d", d: delta });
          });
          const message = await stream.finalMessage();
          send({ t: "end", content: message.content, stop_reason: message.stop_reason });
        };
        try {
          await run(params);
        } catch (caught) {
          if (!started && thinkingRejected(caught)) {
            // Telefonul își curăță și el istoricul, ca următoarea cerere să nu mai dea eroarea.
            send({ t: "strip" });
            try {
              await run({ ...params, messages: withoutThinking(messages) });
            } catch (again) {
              send({ t: "err", error: errorMessage(again) });
            }
          } else send({ t: "err", error: errorMessage(caught) });
        }
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  }

  try {
    let stripped = false;
    const response = await client.beta.messages.create(params).catch((caught) => {
      if (!thinkingRejected(caught)) throw caught;
      stripped = true;
      return client.beta.messages.create({ ...params, messages: withoutThinking(messages) });
    });
    return NextResponse.json(
      { content: response.content, stop_reason: response.stop_reason, strip: stripped },
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
      return NextResponse.json({ error: errorMessage(caught) }, { status: 502 });
    }
    return NextResponse.json({ error: "Nu pot ajunge la Claude." }, { status: 502 });
  }
}
