import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "jarvis_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // un an: te loghezi o singură dată pe telefon

function sessionValue(): string {
  const secret = process.env.SESSION_SECRET;
  const passcode = process.env.JARVIS_PASSCODE;
  if (!secret || !passcode) {
    throw new Error("Lipsesc SESSION_SECRET sau JARVIS_PASSCODE.");
  }
  // Schimbarea codului invalidează automat toate sesiunile vechi.
  return createHmac("sha256", secret).update(`jarvis:${passcode}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function passcodeMatches(candidate: string): boolean {
  const passcode = process.env.JARVIS_PASSCODE;
  if (!passcode) return false;
  return safeEqual(candidate.trim(), passcode);
}

export function newSessionValue(): string {
  return sessionValue();
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (!value) return false;
  try {
    return safeEqual(value, sessionValue());
  } catch {
    return false;
  }
}
