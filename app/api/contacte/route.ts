import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError, google } from "@/lib/google";

const PEOPLE = "https://people.googleapis.com/v1";

type Person = {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
};

// Doar citire: caută în Contacte și în „alte contacte” (cei cu care a schimbat mailuri).
export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const query = (new URL(request.url).searchParams.get("cauta") ?? "").trim();
  if (!query) return NextResponse.json({ error: "Spune ce nume caut." }, { status: 400 });
  try {
    const search = (path: string, mask: string) =>
      google<{ results?: { person?: Person }[] }>(`${PEOPLE}/${path}?${new URLSearchParams({ query, readMask: mask, pageSize: "10" })}`).catch(
        (error) => (error instanceof GoogleError && /Reconectează|conectat|expirat/.test(error.message) ? Promise.reject(error) : { results: [] }),
      );
    const [own, other] = await Promise.all([
      search("people:searchContacts", "names,emailAddresses,phoneNumbers"),
      search("otherContacts:search", "names,emailAddresses"),
    ]);
    const seen = new Set<string>();
    const contacte = [...(own.results ?? []), ...(other.results ?? [])]
      .map(({ person }) => ({
        nume: person?.names?.[0]?.displayName ?? "",
        mail: person?.emailAddresses?.map((item) => item.value).filter(Boolean) ?? [],
        telefon: person?.phoneNumbers?.map((item) => item.value).filter(Boolean) ?? [],
      }))
      .filter((item) => {
        const key = `${item.nume}|${item.mail[0] ?? ""}`;
        if (seen.has(key) || (!item.nume && !item.mail.length)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
    return NextResponse.json({ contacte });
  } catch (caught) {
    const message = caught instanceof GoogleError ? caught.message : "Nu am putut ajunge la Contacte.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
