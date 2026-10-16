import Anthropic from "@anthropic-ai/sdk";
import { getCerere, saveCerere } from "@/lib/cereri";
import { memoryPrompt } from "@/lib/memorie";
import { notify } from "@/lib/push";

// „Mă documentez și revin”: Claude caută și citește pe internet, pe server, cât Daniel vorbește mai departe cu Argus.
// Rezultatul ajunge în coada de cereri ca „gata”, iar telefonul îl anunță cu voce, ca la laptop.

const MODEL = process.env.ARGUS_RESEARCH_MODEL || process.env.ARGUS_MODEL || "claude-sonnet-5-5";
const MAX_ROUNDS = 6;

const SYSTEM = `Ești partea de cercetare a lui Argus, asistentul vocal al lui Daniel (Executive Sales Manager la OVB Allfinanz România, Alba Iulia).
Daniel ți-a cerut ceva ce trebuie căutat. Cauți pe internet, citești sursele bune și răspunzi în română, cu diacritice.

Forma răspunsului, fără excepții:
- Primul paragraf: răspunsul direct, în una-două propoziții scurte, bune de citit cu voce tare cât Daniel conduce. Fără linkuri, simboluri sau liste în el.
- Apoi, dacă ajută, cel mult 8 rânduri scurte cu detaliile importante (cifre, date, variante), fiecare pe rândul lui, începând cu „- ”.
- La final, un rând „Surse: ” cu cel mult 3 site-uri (doar numele domeniului).
Nu inventa nimic: dacă nu găsești sigur, spui asta în primul paragraf.
Nu lucrezi cu date personale ale clienților OVB, parole sau plăți.`;

export async function research(id: string, intrebare: string) {
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: intrebare }];
  let text = "";
  let failed = "";
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 3000,
        system: SYSTEM + (await memoryPrompt()),
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 6, user_location: { type: "approximate", timezone: "Europe/Bucharest" } },
          { type: "web_fetch_20250910", name: "web_fetch", max_uses: 4 },
        ],
        messages,
      });
      messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
      text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
      if (response.stop_reason !== "pause_turn") break;
    }
  } catch (caught) {
    failed = caught instanceof Anthropic.APIError ? `Claude a răspuns cu eroare ${caught.status ?? ""}.` : "Nu am putut termina căutarea.";
  }
  const cerere = await getCerere(id);
  if (!cerere) return;
  const ok = !failed && Boolean(text);
  await saveCerere({
    ...cerere,
    status: ok ? "gata" : "eroare",
    rezultat: ok ? text : failed || "Nu am găsit nimic sigur.",
    actualizat: new Date().toISOString(),
  });
  const answer = (ok ? text : failed).split(/\n\s*\n/)[0] ?? "";
  await notify(ok ? `Am găsit: ${cerere.titlu.replace(/^Cercetare:\s*/, "")}` : "Cercetarea n-a mers", answer, id);
}
