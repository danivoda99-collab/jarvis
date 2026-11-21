// Apelul telefonic pentru lucrurile cu adevărat urgente: Twilio sună pe telefonul lui Daniel și citește mesajul în română.
// Merge doar dacă în Vercel sunt puse TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (numărul Twilio) și DANIEL_TELEFON;
// altfel nu face nimic, iar alerta rămâne o notificare urgentă. Cel mult un apel la 30 de minute, ca să nu-l sune în buclă.

import { command } from "@/lib/cereri";

const ULTIMUL = "argus:apel:ultimul";

function xml(text: string) {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}

export function apelConfigurat() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM && process.env.DANIEL_TELEFON);
}

export async function suna(mesaj: string): Promise<"sunat" | "neconfigurat" | "prea-des" | "eroare"> {
  if (!apelConfigurat()) return "neconfigurat";
  const pus = await command<string | null>("SET", ULTIMUL, "1", "NX", "EX", 30 * 60);
  if (!pus) return "prea-des";
  const sid = process.env.TWILIO_ACCOUNT_SID as string;
  const text = xml(mesaj.slice(0, 400));
  const twiml = `<Response><Say voice="Polly.Carmen" language="ro-RO">Bună, sunt Argus. ${text}</Say><Pause length="1"/><Say voice="Polly.Carmen" language="ro-RO">Repet. ${text}</Say><Say voice="Polly.Carmen" language="ro-RO">Detaliile sunt în aplicație.</Say></Response>`;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: process.env.DANIEL_TELEFON as string, From: process.env.TWILIO_FROM as string, Twiml: twiml }),
      cache: "no-store",
    });
    return r.ok ? "sunat" : "eroare";
  } catch {
    return "eroare";
  }
}
