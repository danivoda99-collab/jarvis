import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError, google } from "@/lib/google";

const DRIVE = "https://www.googleapis.com/drive/v3/files";

type File = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string };

// Documentele Google se exportă ca text, tabelele ca CSV; restul doar dacă sunt deja text.
const EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const kind = (mime: string) =>
  mime.includes("document") ? "document" : mime.includes("spreadsheet") ? "tabel" : mime.includes("presentation") ? "prezentare" : mime.includes("pdf") ? "PDF" : mime.includes("folder") ? "folder" : mime.split("/").pop();

// Doar citire: ?cauta=<cuvinte> caută după nume și conținut; ?id=<id> dă textul unui fișier.
export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  try {
    const id = params.get("id");
    if (id) {
      const file = await google<File>(`${DRIVE}/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime`);
      const exportAs = EXPORT[file.mimeType];
      if (!exportAs && !file.mimeType.startsWith("text/")) {
        return NextResponse.json({ nume: file.name, tip: kind(file.mimeType), text: "", nota: "Fișierul nu e text; laptopul îl poate deschide." });
      }
      const url = exportAs ? `${DRIVE}/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}` : `${DRIVE}/${file.id}?alt=media`;
      const text = String(await google<string>(url));
      return NextResponse.json({ nume: file.name, tip: kind(file.mimeType), modificat: file.modifiedTime, text: text.slice(0, 8000) });
    }
    const words = (params.get("cauta") ?? "").replace(/['\\]/g, " ").trim();
    const q = [
      "trashed = false",
      words ? `(name contains '${words}' or fullText contains '${words}')` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    const query = new URLSearchParams({ q, pageSize: "10", fields: "files(id,name,mimeType,modifiedTime,webViewLink)" });
    // Fără cuvinte: cele mai recente. Căutarea în conținut nu se poate ordona, Google o dă după relevanță.
    if (!words) query.set("orderBy", "modifiedTime desc");
    const data = await google<{ files?: File[] }>(`${DRIVE}?${query}`);
    return NextResponse.json({
      fisiere: (data.files ?? []).map((file) => ({ id: file.id, nume: file.name, tip: kind(file.mimeType), modificat: file.modifiedTime, link: file.webViewLink })),
    });
  } catch (caught) {
    const message = caught instanceof GoogleError ? caught.message : "Nu am putut ajunge la Google Drive.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
