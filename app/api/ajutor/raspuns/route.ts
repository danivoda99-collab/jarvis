import { NextResponse } from "next/server";
import { readTicket } from "@/lib/ajutor";

// Pagina de ajutor întreabă dacă a venit răspunsul lui Argus la biletele ei. Biletul e un id aleator, știut doar de telefonul omului.
export async function GET(request: Request) {
  const ids = (new URL(request.url).searchParams.get("bilete") ?? "").split(",").filter(Boolean).slice(0, 10);
  try {
    const tickets = await Promise.all(ids.map(async (id) => [id, await readTicket(id)] as const));
    return NextResponse.json({ bilete: Object.fromEntries(tickets.filter(([, ticket]) => ticket)) });
  } catch {
    return NextResponse.json({ bilete: {} });
  }
}
