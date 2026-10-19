import { cookies } from "next/headers";
import { openToken, sealToken } from "@/lib/google";

// Spotify (ales de Daniel pe 19.10.2026): pornește, oprește și schimbă muzica pe telefonul sau laptopul lui, prin contul Premium.
// Tokenul de reîmprospătare stă criptat într-un cookie, ca la Google.
export const SPOTIFY_COOKIE = "argus_spotify";
export const SPOTIFY_STATE = "argus_spotify_state";
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private";

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

async function accessToken(): Promise<string> {
  const sealed = (await cookies()).get(SPOTIFY_COOKIE)?.value;
  const refresh = sealed ? openToken(sealed) : null;
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
