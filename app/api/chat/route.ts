import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { ARGUS_SYSTEM, ARGUS_TOOLS, DRIVING, SPOKEN_ROMANIAN } from "@/lib/argus";
import { memoryPrompt } from "@/lib/memorie";
import { LaptopError, apiPaused, askLaptop, creditGone, motivText, noteSource, rememberApiFailure, toolId } from "@/lib/creier";
import { parseReply, renderTurn, toolProtocol } from "@/lib/creier-format";

// Un pas din conversație: aplicația trimite istoricul, Claude răspunde cu text sau cu unelte de rulat.
// Întâi API-ul (cel mai rapid). Când nu mai are credit sau dă eroare, răspunde Claude de pe laptop (abonamentul lui
// Daniel), până se adaugă credit (Daniel, 12.11.2026). Uneltele rulează în browser, ca să poată arăta ferestre și cere confirmări.

// Un pas poate aștepta laptopul și apoi rezerva.
export const maxDuration = 180;
// ARGUS_CREIER în Vercel: „api” = doar API-ul, „laptop” = întâi laptopul; altfel (implicit) întâi API-ul, laptopul rezervă.
const MODE = process.env.ARGUS_CREIER ?? "api-intai";

// Creierul de pe telefon: Opus 5.5 (mai deștept la alegerea uneltelor și la cereri încâlcite), cu gândire puțină ca să rămână rapid.
const MODEL = process.env.ARGUS_MODEL || "claude-opus-5-5";
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

// Când n-a mers nimic: o singură propoziție care spune cauzele, bună de auzit.
function failureText(failures: { api?: unknown; laptop?: LaptopError }) {
  const parts: string[] = [];
  if (failures.api !== undefined) {
    const caught = failures.api;
    if (!process.env.ANTHROPIC_API_KEY) parts.push("API-ul nu are cheie");
    else if (creditGone(caught)) parts.push("API-ul nu mai are credit");
    else if (caught instanceof Anthropic.AuthenticationError) parts.push("cheia API nu e validă");
    else parts.push(errorMessage(caught).replace(/\.$/, ""));
  }
  if (failures.laptop) parts.push(motivText(failures.laptop).replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()));
  return `${parts.join(", iar ") || "Nu pot ajunge la Claude"}. Mai încearcă peste un minut.`.replace(/^./, (c) => c.toUpperCase());
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

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "lipsa" });
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

  // Laptopul primește instrucțiunile fixe (cu uneltele descrise în ele) și, separat, ce se schimbă la fiecare cerere.
  const language = romanian ? ARGUS_SYSTEM + SPOKEN_ROMANIAN : ARGUS_SYSTEM;
  const laptopStep = async (onDelta?: (text: string) => void) => {
    const raw = await askLaptop(
      { sistem: language + toolProtocol(ARGUS_TOOLS), continut: renderTurn(messages, (driving ? DRIVING : "") + memory), nivel: "mare", web: true },
      { onDelta },
    );
    const reply = parseReply(raw, ARGUS_TOOLS, toolId);
    if (!reply.content.length) throw new LaptopError("eroare", "Claude de pe laptop a răspuns gol.");
    return reply;
  };

  // Ordinea: întâi API-ul (mai rapid), iar când nu are credit sau dă eroare, laptopul (abonamentul).
  // Cât API-ul e fără credit, nu-l mai încercăm la fiecare întrebare: mergem direct pe laptop câteva minute.
  const apiDown = hasKey && MODE !== "laptop" ? await apiPaused() : null;
  const order: ("api" | "laptop")[] =
    MODE === "api" ? ["api"] : MODE === "laptop" ? ["laptop", "api"] : hasKey && !apiDown ? ["api", "laptop"] : ["laptop", "api"];

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
        const viaApi = async () => {
          if (!hasKey) throw new Error("fără cheie");
          try {
            await run(params);
          } catch (caught) {
            if (started || !thinkingRejected(caught)) throw caught;
            // Telefonul își curăță și el istoricul, ca următoarea cerere să nu mai dea eroarea.
            send({ t: "strip" });
            await run({ ...params, messages: withoutThinking(messages) });
          }
        };
        const failures: { api?: unknown; laptop?: LaptopError } = {};
        for (const source of order) {
          try {
            if (source === "api") {
              await viaApi();
              void noteSource("api");
            } else {
              const reply = await laptopStep((delta) => {
                started = true;
                send({ t: "d", d: delta });
              });
              send({ t: "end", content: reply.content, stop_reason: reply.stop_reason });
              void noteSource(order[0] === "laptop" ? "laptop" : "rezerva");
            }
            controller.close();
            return;
          } catch (caught) {
            if (source === "api") {
              failures.api = caught;
              await rememberApiFailure(caught);
            } else failures.laptop = caught instanceof LaptopError ? caught : new LaptopError("eroare", "", started);
            // A apucat să vorbească: nu repetăm răspunsul de pe cealaltă sursă.
            if (started) break;
          }
        }
        send({ t: "err", error: started ? "Răspunsul s-a întrerupt. Mai spune o dată." : failureText(failures) });
        void noteSource("nimic", failures.laptop?.motiv);
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  }

  const failures: { api?: unknown; laptop?: LaptopError } = {};
  for (const source of order) {
    try {
      if (source === "api") {
        if (!hasKey) throw new Error("fără cheie");
        let stripped = false;
        const response = await client.beta.messages.create(params).catch((caught) => {
          if (!thinkingRejected(caught)) throw caught;
          stripped = true;
          return client.beta.messages.create({ ...params, messages: withoutThinking(messages) });
        });
        void noteSource("api");
        return NextResponse.json({ content: response.content, stop_reason: response.stop_reason, strip: stripped }, { headers: { "Cache-Control": "no-store" } });
      }
      const reply = await laptopStep();
      void noteSource(order[0] === "laptop" ? "laptop" : "rezerva");
      return NextResponse.json({ content: reply.content, stop_reason: reply.stop_reason, strip: false }, { headers: { "Cache-Control": "no-store" } });
    } catch (caught) {
      if (source === "api") {
        failures.api = caught;
        await rememberApiFailure(caught);
      } else failures.laptop = caught instanceof LaptopError ? caught : new LaptopError("eroare", "");
    }
  }
  void noteSource("nimic", failures.laptop?.motiv);
  return NextResponse.json({ error: failureText(failures) }, { status: 502 });
}
