// Creierul de pe laptop (Claude Code, pe abonamentul lui Daniel) nu primește uneltele telefonului ca unelte adevărate:
// le primește descrise în instrucțiuni și le cere într-un bloc <unelte>[…]</unelte> la finalul răspunsului.
// Aici e doar forma: cum arată cererea trimisă laptopului și cum se citește răspunsul lui. Fără rețea, ca să se poată testa.

export type Bloc =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type Unealta = { name?: string; description?: string; input_schema?: unknown; type?: string | null };
type Mesaj = { role: string; content: unknown };

export type Raspuns = {
  content: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> })[];
  stop_reason: "tool_use" | "end_turn";
};

const OPEN = "<unelte>";
const CLOSE = "</unelte>";

// Uneltele care rulează pe telefon (cele de server, cum e căutarea pe internet, le are laptopul pe ale lui).
export function phoneTools(tools: readonly Unealta[]) {
  return tools.filter((tool) => typeof tool.name === "string" && tool.input_schema !== undefined);
}

export function toolProtocol(tools: readonly Unealta[]): string {
  const list = phoneTools(tools).map((tool) => ({ name: tool.name, description: tool.description, input: tool.input_schema }));
  return `

# Cum chemi uneltele (rulează pe telefonul lui Daniel, nu la tine)
Singura ta unealtă proprie e căutarea pe internet (WebSearch), pe care o folosești direct când ai nevoie de ceva la zi. Înainte de o căutare nu scrii nimic: replica (cu <spoken> și <ro>) o scrii o singură dată, după ce ai rezultatele. Toate celelalte unelte de mai jos le rulează aplicația de pe telefon.
Când ai nevoie de una sau mai multe, scrii întâi replica scurtă pentru Daniel, în forma obișnuită, apoi, la sfârșitul răspunsului, un singur bloc:
${OPEN}[{"name":"numele_uneltei","input":{}}]${CLOSE}
și te oprești acolo. Blocul e o listă JSON validă, cu „input” după schema uneltei. Rezultatele le primești în mesajul următor, la „Rezultatele uneltelor”; abia atunci continui.
Nu inventezi rezultate. Nu scrii blocul dacă nu chemi nimic. Nu pomenești blocul sau numele uneltelor în replica pentru Daniel.

Lista uneltelor (nume, descriere, schema pentru input):
${JSON.stringify(list)}`;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

// Toată conversația de până acum, ca un singur mesaj pentru laptop. Pozele rămân poze.
export function renderTurn(messages: readonly Mesaj[], context = ""): Bloc[] {
  const blocks: Bloc[] = [];
  let text =
    "Conversație cu Daniel, independentă de orice altceva din această sesiune. Mai jos e tot ce s-a spus până acum; scrii doar următoarea replică a lui Argus.";
  if (context.trim()) text += `\n\n<context>\n${context.trim()}\n</context>`;
  text += "\n\n<conversatie>";
  const names = new Map<string, string>();
  let photos = 0;
  const flush = () => {
    if (text) blocks.push({ type: "text", text });
    text = "";
  };
  for (const message of messages) {
    const who = message.role === "assistant" ? "Argus" : "Daniel";
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    const said: string[] = [];
    const calls: { name: string; input: unknown }[] = [];
    const results: string[] = [];
    for (const raw of parts) {
      const part = raw as { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { type: "base64"; media_type: string; data: string } };
      if (part.type === "text" && part.text) said.push(part.text);
      else if (part.type === "tool_use" && part.name) {
        calls.push({ name: part.name, input: part.input ?? {} });
        if (part.id) names.set(part.id, part.name);
      } else if (part.type === "tool_result") {
        const name = names.get(part.tool_use_id ?? "") ?? "unealtă";
        results.push(`- [${name}]${part.is_error ? " (eroare)" : ""} ${resultText(part.content) || "(fără text)"}`);
      } else if (part.type === "image" && part.source?.type === "base64") {
        photos += 1;
        said.push(`[poza ${photos}, atașată imediat după acest text]`);
        text += `\n\n${who}: ${said.splice(0).join("\n")}`;
        flush();
        blocks.push({ type: "image", source: part.source });
      }
      // Gândirea și căutările făcute pe server nu se trimit mai departe.
    }
    if (said.length || calls.length) {
      text += `\n\n${who}: ${said.join("\n")}`;
      if (calls.length) text += `\n${OPEN}${JSON.stringify(calls)}${CLOSE}`;
    }
    if (results.length) text += `\n\nRezultatele uneltelor:\n${results.join("\n")}`;
  }
  text += "\n</conversatie>";
  flush();
  return blocks;
}

// Ce se poate spune deja cu voce din textul venit până acum: fără blocul de unelte și fără un început de bloc rămas la coadă.
export function visiblePart(raw: string): string {
  const at = raw.indexOf("<unelte");
  if (at >= 0) return raw.slice(0, at);
  for (let size = Math.min(OPEN.length - 1, raw.length); size > 0; size -= 1) {
    if (raw.endsWith(OPEN.slice(0, size))) return raw.slice(0, -size);
  }
  return raw;
}

function readCalls(text: string): unknown[] {
  const from = text.indexOf("[");
  const to = text.lastIndexOf("]");
  if (from < 0 || to <= from) return [];
  try {
    const parsed = JSON.parse(text.slice(from, to + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Răspunsul laptopului, adus la forma pe care o știe telefonul (aceeași ca de la API).
export function parseReply(raw: string, tools: readonly Unealta[], newId: () => string): Raspuns {
  const known = new Set(phoneTools(tools).map((tool) => tool.name));
  const at = raw.lastIndexOf(OPEN);
  const text = (at >= 0 ? raw.slice(0, at) : raw).trimEnd();
  const content: Raspuns["content"] = [];
  if (text.trim()) content.push({ type: "text", text });
  if (at >= 0) {
    const end = raw.indexOf(CLOSE, at);
    for (const item of readCalls(raw.slice(at + OPEN.length, end >= 0 ? end : undefined))) {
      const call = item as { name?: unknown; input?: unknown };
      if (typeof call?.name !== "string" || !known.has(call.name)) continue;
      const input = call.input && typeof call.input === "object" && !Array.isArray(call.input) ? (call.input as Record<string, unknown>) : {};
      content.push({ type: "tool_use", id: newId(), name: call.name, input });
    }
  }
  const called = content.some((block) => block.type === "tool_use");
  return { content, stop_reason: called ? "tool_use" : "end_turn" };
}

// Un rând „data: …” din fluxul Upstash (SSE): „message,canal,conținut” sau „subscribe,canal,1”.
export function parseSse(line: string): { kind: string; payload: string } | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data.startsWith("[")) {
    try {
      const parts = JSON.parse(data) as unknown[];
      if (Array.isArray(parts) && typeof parts[0] === "string") return { kind: parts[0], payload: String(parts[2] ?? "") };
    } catch {
      // nu e listă JSON: îl citim ca text cu virgule
    }
  }
  const first = data.indexOf(",");
  if (first < 0) return { kind: data, payload: "" };
  const second = data.indexOf(",", first + 1);
  return { kind: data.slice(0, first), payload: second < 0 ? "" : data.slice(second + 1) };
}
