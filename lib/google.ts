import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { command } from "@/lib/cereri";

export const GOOGLE_COOKIE = "argus_google";
export const TIME_ZONE = "Europe/Bucharest";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/spreadsheets",
  // Doar citire (aprobat de Daniel pe 17.10.2026): mailuri, contacte, fișiere din Drive.
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

function secretKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Lipsește SESSION_SECRET.");
  return createHash("sha256").update(`google:${secret}`).digest();
}

// Tokenul de reîmprospătare Google stă criptat într-un cookie, nu în cod sau în baza de date.
export function sealToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openToken(sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const STATE_COOKIE = "argus_google_state";

export function newOauthState(): string {
  return randomBytes(16).toString("hex");
}

export function redirectUri(origin: string): string {
  return `${origin}/api/google/callback`;
}

export function consentUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      ...body,
    }),
    cache: "no-store",
  });
  return (await response.json()) as { access_token?: string; refresh_token?: string; error?: string };
}

export async function exchangeCode(code: string, origin: string) {
  return tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri(origin) });
}

export async function googleConnected(): Promise<boolean> {
  const sealed = (await cookies()).get(GOOGLE_COOKIE)?.value;
  return Boolean(sealed && openToken(sealed));
}

export class GoogleError extends Error {}

// Face un apel la Google cu un token de acces nou, obținut din cel de reîmprospătare.
// Telefonul ține conexiunea în cookie; o copie criptată stă și în Redis, ca laptopul (care n-are cookie-ul Google)
// să poată citi sarcinile pentru reamintiri. Doar cererile autentificate ajung aici.
const SHARED_TOKEN = "argus:google";
let sharedSaved = "";

// Tokenurile de încercat, în ordine: al aparatului (cookie), apoi copia comună. Dacă al telefonului a expirat,
// dar laptopul s-a reconectat între timp, merge cu copia comună fără ca Daniel să mai apese ceva.
async function refreshTokens(): Promise<{ token: string; sealed: string; shared: boolean }[]> {
  const own = (await cookies()).get(GOOGLE_COOKIE)?.value;
  const shared = await command<string | null>("GET", SHARED_TOKEN).catch(() => null);
  const list: { token: string; sealed: string; shared: boolean }[] = [];
  const ownToken = own ? openToken(own) : null;
  if (own && ownToken) list.push({ token: ownToken, sealed: own, shared: own === shared });
  const sharedToken = shared ? openToken(shared) : null;
  if (shared && sharedToken && sharedToken !== ownToken) list.push({ token: sharedToken, sealed: shared, shared: true });
  return list;
}

// După „Conectează Google” (de pe telefon sau de pe laptop), tokenul nou devine imediat și copia comună.
export async function saveSharedToken(sealed: string) {
  await command("SET", SHARED_TOKEN, sealed);
  sharedSaved = sealed;
}

export async function google<T>(url: string, init: RequestInit = {}): Promise<T> {
  const tokens = await refreshTokens();
  if (!tokens.length) {
    throw new GoogleError("Google nu e conectat. Daniel trebuie să apese „Conectează Google” în aplicație.");
  }
  let accessToken: string | undefined;
  for (const candidate of tokens) {
    ({ access_token: accessToken } = await tokenRequest({ refresh_token: candidate.token, grant_type: "refresh_token" }));
    if (!accessToken) continue;
    // Tokenul care merge devine copia comună (laptopul și paznicul o folosesc), dacă nu era deja.
    if (!candidate.shared && sharedSaved !== candidate.sealed) {
      await command("SET", SHARED_TOKEN, candidate.sealed)
        .then(() => (sharedSaved = candidate.sealed))
        .catch(() => undefined);
    }
    break;
  }
  if (!accessToken) {
    throw new GoogleError("Conexiunea cu Google a expirat. Daniel trebuie să apese din nou „Conectează Google”.");
  }
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
  });
  if (response.status === 403) {
    throw new GoogleError("Argus nu are încă voie aici. Daniel trebuie să apese „Reconectează Google” în aplicație.");
  }
  if (!response.ok) {
    throw new GoogleError(`Google a răspuns cu ${response.status}.`);
  }
  if (response.status === 204) return null as T;
  return ((response.headers.get("content-type") ?? "").includes("json") ? await response.json() : await response.text()) as T;
}

// Ora României pentru o dată locală „2026-10-15T10:00”, ca RFC 3339 cu fus orar.
export function bucharestIso(local: string): string {
  const [datePart, timePart = "00:00"] = local.split("T");
  const guess = new Date(`${datePart}T${timePart.slice(0, 5)}:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
    .formatToParts(guess)
    .find((part) => part.type === "timeZoneName")
    ?.value.replace("GMT", "");
  return `${datePart}T${timePart.slice(0, 5)}:00${offset || "+00:00"}`;
}

export function todayInBucharest(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString("ro-RO", {
    timeZone: TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Pentru paznic: merge reîmprospătarea cu tokenul comun (fără cookie)? „expirat” = Daniel trebuie să reconecteze Google.
export async function googleHealth(): Promise<"ok" | "expirat" | "neconectat" | "necunoscut"> {
  const shared = await command<string | null>("GET", SHARED_TOKEN).catch(() => null);
  const refreshToken = shared ? openToken(shared) : null;
  if (!refreshToken) return "neconectat";
  try {
    const result = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
    if (result.access_token) return "ok";
    return result.error === "invalid_grant" ? "expirat" : "necunoscut";
  } catch {
    return "necunoscut";
  }
}

// Bilet de o singură folosință pentru reconectarea automată de pe laptop: Chrome-ul de acolo nu are sesiunea Argus,
// așa că paznicul îi dă o adresă /api/google/connect?bilet=… valabilă 15 minute.
const BILET = (id: string) => `argus:google:bilet:${id}`;
export async function newReconnectTicket(): Promise<string> {
  const id = randomBytes(18).toString("hex");
  await command("SET", BILET(id), "1", "EX", 15 * 60);
  return id;
}
export async function useReconnectTicket(id: string | null): Promise<boolean> {
  if (!id || !/^[0-9a-f]{36}$/.test(id)) return false;
  return (await command<number>("DEL", BILET(id)).catch(() => 0)) === 1;
}
