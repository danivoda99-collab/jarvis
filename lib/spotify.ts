import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { command } from "@/lib/cereri";
import { openToken, sealToken } from "@/lib/google";

// Spotify (ales de Daniel pe 19.10.2026): pornește, oprește și schimbă muzica pe telefonul sau laptopul lui, prin contul Premium.
// Tokenul de reîmprospătare stă criptat într-un cookie, ca la Google.
export const SPOTIFY_COOKIE = "argus_spotify";
export const SPOTIFY_STATE = "argus_spotify_state";
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read";

export const spotifyRedirect = (origin: string) => `${origin}/api/spotify/callback`;

export function spotifyConsentUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: spotifyRedirect(origin),
    scope: SCOPES,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function tokenRequest(body: Record<string, string>) {
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID ?? ""}:${process.env.SPOTIFY_CLIENT_SECRET ?? ""}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  return (await response.json()) as { access_token?: string; refresh_token?: string; error?: string };
}

export const exchangeSpotifyCode = (code: string, origin: string) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: spotifyRedirect(origin) });

export { sealToken };

export async function spotifyConnected(): Promise<boolean> {
  const sealed = (await cookies()).get(SPOTIFY_COOKIE)?.value;
  return Boolean(sealed && openToken(sealed));
}

export class SpotifyError extends Error {}

// O copie criptată a conexiunii stă și în Redis, ca linkul de dimineață din Scurtături (fără cookie) să poată porni muzica.
const SHARED_TOKEN = "argus:spotify";
let sharedSaved = "";

async function refreshToken(): Promise<string | null> {
  const sealed = (await cookies()).get(SPOTIFY_COOKIE)?.value;
  const own = sealed ? openToken(sealed) : null;
  if (own && sealed) {
    if (sharedSaved !== sealed) {
      await command("SET", SHARED_TOKEN, sealed)
        .then(() => (sharedSaved = sealed))
        .catch(() => undefined);
    }
    return own;
  }
  const shared = await command<string | null>("GET", SHARED_TOKEN).catch(() => null);
  return shared ? openToken(shared) : null;
}

// Cheia din linkul de dimineață: derivată din SESSION_SECRET, o vede doar Daniel în Setări.
export function morningKey(): string {
  return createHmac("sha256", process.env.SESSION_SECRET ?? "").update("argus-dimineata").digest("hex").slice(0, 32);
}

async function accessToken(): Promise<string> {
  const refresh = await refreshToken();
  if (!refresh) throw new SpotifyError("Spotify nu e conectat. Daniel trebuie să apese „Conectează Spotify” în aplicație.");
  const { access_token: token } = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
  if (!token) throw new SpotifyError("Conexiunea cu Spotify a expirat. Daniel trebuie să apese din nou „Conectează Spotify”.");
  return token;
}

export type SpotifyCall = <T>(path: string, init?: RequestInit) => Promise<{ status: number; data: T | null }>;

// Un client cu un singur token pe cerere (Spotify cere același token pentru mai multe apeluri la rând).
export async function spotifyClient(): Promise<SpotifyCall> {
  const token = await accessToken();
  return async <T>(path: string, init: RequestInit = {}) => {
    const response = await fetch(`https://api.spotify.com/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
      cache: "no-store",
    });
    const text = await response.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    return { status: response.status, data };
  };
}

type Item = { name: string; uri: string; artists?: { name: string }[]; owner?: { display_name?: string } };
export type { Item as SpotifyItem };

// Fără diacritice și majuscule, ca „Dimineață” să se potrivească cu „dimineata”.
export function plain(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const LIKED = /\b(favorit|apreciat|liked|preferat|melodiile mele|piesele mele|biblioteca)/;

// Playlisturile lui Daniel (inclusiv cele private): întâi potrivirea exactă, apoi cea care conține ce a cerut.
export async function ownPlaylist(call: SpotifyCall, query: string, loose: boolean): Promise<Item | undefined> {
  const wanted = plain(query).replace(/^playlist(ul)?\s+/, "");
  const lists: Item[] = [];
  for (let offset = 0; offset < 200; offset += 50) {
    const { data } = await call<{ items: (Item | null)[]; next: string | null }>(`/me/playlists?limit=50&offset=${offset}`);
    lists.push(...((data?.items ?? []).filter(Boolean) as Item[]));
    if (!data?.next) break;
  }
  const exact = lists.find((item) => plain(item.name) === wanted);
  if (exact) return exact;
  // Numele playlistului conține ce a spus („chill” → „Chill seara”); invers doar când a cerut clar un playlist.
  const contains = lists.find((item) => (wanted.length > 2 && plain(item.name).includes(wanted)) || (loose && wanted.length > 3 && wanted.includes(plain(item.name))));
  if (contains) return contains;
  // Altfel, cel cu cele mai multe cuvinte comune („every morning” → „Every morning, every day”), cel puțin jumătate.
  const words = new Set(wanted.split(" ").filter((word) => word.length > 1));
  let best: Item | undefined;
  let bestScore = 0;
  for (const item of lists) {
    const name = new Set(plain(item.name).split(" "));
    const score = [...words].filter((word) => name.has(word)).length / Math.max(1, words.size);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 && (loose || bestScore === 1) ? best : undefined;
}

