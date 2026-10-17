import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError, google } from "@/lib/google";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

type Header = { name: string; value: string };
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] };
type Message = { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: Part };

function failure(caught: unknown) {
  const message = caught instanceof GoogleError ? caught.message : "Nu am putut ajunge la Gmail.";
  return NextResponse.json({ error: message }, { status: 502 });
}

const header = (message: Message, name: string) =>
  message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const decode = (data = "") => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

// Textul simplu al mailului; dacă are doar HTML, scoatem etichetele.
function bodyText(part?: Part): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const text = bodyText(child);
    if (text) return text;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decode(part.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  }
  return "";
}

function summary(message: Message) {
  return {
    id: message.id,
    de_la: header(message, "From"),
    catre: header(message, "To") || undefined,
    subiect: header(message, "Subject") || "(fără subiect)",
    data: header(message, "Date"),
    necitit: message.labelIds?.includes("UNREAD") ?? false,
    important: message.labelIds?.includes("IMPORTANT") ?? false,
    inceput: message.snippet,
  };
}

// Doar citire: ?cauta=<sintaxa Gmail> listează mailuri; ?id=<id> dă textul unui mail.
export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  try {
    const id = params.get("id");
    if (id) {
      const message = await google<Message>(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
      const text = bodyText(message.payload).replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      return NextResponse.json({ ...summary(message), text: text.slice(0, 6000) });
    }
    const max = Math.min(Number(params.get("max")) || 10, 20);
    const query = new URLSearchParams({ q: params.get("cauta") || "in:inbox newer_than:1d", maxResults: String(max) });
    const list = await google<{ messages?: { id: string }[] }>(`${GMAIL}/messages?${query}`);
    const metadata = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
    const messages = await Promise.all(
      (list.messages ?? []).map((item) => google<Message>(`${GMAIL}/messages/${item.id}?${metadata}`)),
    );
    return NextResponse.json({ mailuri: messages.map(summary) });
  } catch (caught) {
    return failure(caught);
  }
}
