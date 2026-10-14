import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

export const GOOGLE_COOKIE = "argus_google";
export const TIME_ZONE = "Europe/Bucharest";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
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

function openToken(sealed: string): string | null {
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
export async function google<T>(url: string, init: RequestInit = {}): Promise<T> {
  const sealed = (await cookies()).get(GOOGLE_COOKIE)?.value;
  const refreshToken = sealed ? openToken(sealed) : null;
  if (!refreshToken) {
    throw new GoogleError("Google nu e conectat. Daniel trebuie să apese „Conectează Google” în aplicație.");
  }
  const { access_token: accessToken } = await tokenRequest({
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (!accessToken) {
    throw new GoogleError("Conexiunea cu Google a expirat. Daniel trebuie să apese din nou „Conectează Google”.");
  }
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new GoogleError(`Google a răspuns cu ${response.status}.`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
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
