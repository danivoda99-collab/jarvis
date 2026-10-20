import Anthropic from "@anthropic-ai/sdk";
import { addCerere, command, saveCerere } from "@/lib/cereri";
import { notify } from "@/lib/push";

// Pagina de ajutor pentru echipa Voda (/ajutor): oamenii întreabă cum se completează aplicația Team Vodă,
// iar ce nu se poate lămuri ajunge la Daniel. Asistentul nu vede cifrele nimănui și nu scrie nimic în aplicație.

const MODEL = process.env.ARGUS_AJUTOR_MODEL || "claude-haiku-5-5";

// Ghidul aplicației. Se completează din codul aplicației; ce nu e aici, asistentul nu inventează.
export const GHID = `Aplicația Team Vodă (raportarea colaboratorilor echipei Voda, OVB Allfinanz):
- Te intri cu numele tău (exact cum e în echipă) și codul tău personal. Codul nu se spune nimănui. Dacă ai uitat codul, îl resetează Daniel (BL-ul echipei): apasă „Nu m-am descurcat” sau scrie-i.
- Săptămâna de raportare ține de sâmbătă până vineri. Termenul pentru săptămâna care s-a încheiat: sâmbătă, până la ora 17:00.
- Raportul se adaugă la ce ai deja pe săptămâna aceea (nu înlocuiește). Poți raporta pentru săptămâna curentă și pentru cea trecută.
- Câmpurile raportului:
  - Contacte: oameni noi cu care ai vorbit despre o întâlnire.
  - Intenții de analiză / Analize: întâlniri de analiză programate / făcute.
  - Intenții de consultanță / Consultanțe: consultanțe programate / făcute (prima întâlnire după analiză).
  - Consultanțe 2: a doua consultanță cu același client.
  - Clienți / contracte / unități semnate: ce s-a semnat în săptămână.
  - Clienți / contracte / unități plătite: ce s-a plătit efectiv.
  - Recomandări clienți / colaboratori: recomandări primite.
  - Service: întâlniri de service cu clienți existenți.
- Ai greșit o cifră: în aplicație, la rapoartele tale, alegi raportul și îl corectezi sau îl ștergi, apoi îl trimiți din nou corect. Pentru rapoarte mai vechi, îi spui lui Daniel.
- Obiectivele săptămânii (Tel) le pune BL-ul; le vezi în aplicație.
- Dacă la trimitere apare o eroare de conexiune: verifică internetul, așteaptă câteva secunde și apasă din nou „Trimite”. Nu închide pagina înainte să vezi confirmarea. Dacă tot nu merge, apasă „Nu m-am descurcat”.`;

const SYSTEM = `Ești Argus, asistentul echipei Voda (OVB Allfinanz), pe pagina de ajutor a aplicației Team Vodă.
Răspunzi colaboratorilor, în română, cu diacritice, scurt (cel mult 5 rânduri), prietenos și clar, la întrebări despre cum se completează aplicația.
Folosești doar ghidul de mai jos. Dacă răspunsul nu e în ghid, spui sincer că nu știi sigur și îl rogi să apese „Nu m-am descurcat”, ca să ajungă întrebarea la Daniel. Nu inventezi butoane, câmpuri sau reguli.
Nu ceri și nu repeți coduri, parole sau date despre clienți (nume, CNP, sume). Nu vezi cifrele nimănui și nu completezi în locul omului.
Nu vorbești despre alte subiecte decât aplicația și raportarea; pentru restul, îl trimiți la Daniel.

Ghidul:
${GHID}`;

export type Replica = { rol: "om" | "argus"; text: string };

export async function answer(question: string, history: Replica[]) {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-6).map((item) => ({ role: item.rol === "om" ? ("user" as const) : ("assistant" as const), content: item.text.slice(0, 1500) })),
    { role: "user", content: question },
  ];
  // Conversația trebuie să înceapă cu omul.
  while (messages.length && messages[0].role !== "user") messages.shift();
  const response = await client.messages.create({ model: MODEL, max_tokens: 600, system: SYSTEM, messages });
  return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
}

// Cel mult `max` cereri pe oră de la aceeași adresă, ca pagina publică să nu poată fi folosită la nesfârșit.
export async function allowed(key: string, max: number) {
  const bucket = `ajutor:limita:${key}:${new Date().toISOString().slice(0, 13)}`;
  const count = await command<number>("INCR", bucket);
  if (count === 1) await command("EXPIRE", bucket, 3600);
  return count <= max;
}

// O singură dată la `seconds` pentru aceeași cheie (aceeași problemă nu vine de zece ori).
export async function once(key: string, seconds: number) {
  return (await command<string | null>("SET", `ajutor:o-data:${key}`, "1", "NX", "EX", seconds)) === "OK";
}

// Apare pe telefonul lui Daniel ca notificare și ca fereastră în „Lucrări”.
export async function tellDaniel(title: string, text: string, request: string) {
  const cerere = await addCerere(title, request, undefined, "în lucru");
  await saveCerere({ ...cerere, status: "gata", rezultat: text, actualizat: new Date().toISOString() });
  await notify(title, text.split("\n")[0] ?? text, cerere.id);
}
