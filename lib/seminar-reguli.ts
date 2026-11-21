// Linkul de seminar pentru un om din echipă (Santinela îl trimite singură pe WhatsApp; Daniel, 10.11.2026).
// Sursa: Sheet-ul „OVB PREZENTE” (doar citire): tabul datat al modulului curent (cine e la ce seminar)
// și tabul „ID-uri Referenti” (linkul Zoom, ID-ul și parola fiecărui seminar). Aceleași reguli ca aplicația Team Vodă:
// modulul curent = cel mai nou tab „zz.ll.aaaa” a cărui dată + 5 zile, ora 16:00, a trecut; blocurile încep la „SEMINAR X” / „TO BE X”
// în coloana F; tabelul de traineri (după „Nr. Crt.”) nu contează.

export type Om = { nume: string; bl: string; seminar: string };
export type Link = { seminar: string; link: string; id: string; parola: string };
export type Date_ = { modul: string; oameni: Om[]; linkuri: Link[] };

export const fara = (s: string) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const cuvinte = (s: string) => fara(s).split(" ").filter((w) => w.length >= 2);

// Tabul modulului curent dintre titluri (fără ~, vechi, test, „nu completa”).
export function tabulCurent(titluri: string[], acum = new Date()): string | null {
  const datate = titluri
    .map((titlu) => {
      const m = /^(\d{2})\.(\d{2})\.(\d{4})\.?$/.exec(titlu.trim());
      return m ? { titlu, zi: Date.UTC(+m[3], +m[2] - 1, +m[1]) } : null;
    })
    .filter((x): x is { titlu: string; zi: number } => Boolean(x))
    .sort((a, b) => b.zi - a.zi);
  if (!datate.length) return null;
  // Ora României ≈ UTC+2/+3; 16:00 local = cel târziu 14:00 UTC. Folosim 14:00 UTC (iarna 16:00 local, vara 17:00).
  const activ = datate.find((x) => x.zi + 5 * 86_400_000 + 14 * 3_600_000 <= acum.getTime());
  return (activ ?? datate[datate.length - 1]).titlu;
}

// „SEMINAR BAZA” → „Baza”, „TO BE GST” → „To be GST”, „SEMINAR MANAGEMENT PM” → „Management PM”.
export function numeSeminar(antet: string): string | null {
  const m = /^\s*(SEMINAR(?:UL)?|TO\s+BE)\s+(.+?)\s*$/i.exec(antet ?? "");
  if (!m || !/[a-z]/i.test(m[2])) return null;
  const rest = m[2]
    .split(/\s+/)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
  return /^to/i.test(m[1]) ? `To be ${rest}` : rest;
}

// Oamenii din tabul modulului: coloana C nume, D BL, blocul din F.
export function oameniDinTab(valori: string[][]): Om[] {
  const oameni: Om[] = [];
  let seminar: string | null = null;
  let traineri = false;
  for (const rand of valori) {
    const antet = numeSeminar(rand[5] ?? "");
    if (antet && !(rand[2] ?? "").trim()) {
      seminar = antet;
      traineri = false;
      continue;
    }
    if (/^nr\.?\s*crt/i.test((rand[0] ?? "").trim())) {
      traineri = true;
      continue;
    }
    const nume = (rand[2] ?? "").replace(/\s+/g, " ").trim();
    if (!seminar || traineri || !nume || cuvinte(nume).length < 2) continue;
    oameni.push({ nume, bl: (rand[3] ?? "").trim(), seminar });
  }
  return oameni;
}

// „255 033 4934” din linkul „…/j/2550334934?…”; dacă linkul nu are numărul (link personal), rămâne ID-ul din tabel.
export function idDinLink(link: string, dinTabel: string): string {
  const m = /\/j\/(\d{9,11})/.exec(link);
  if (!m) return dinTabel.trim();
  const d = m[1];
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : d.length === 11 ? `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}` : `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

// Tabul „ID-uri Referenti”: B seminarul, E ID, F parola, G linkul. Se oprește la „LINK EVALUARI”.
// ID-ul se ia din link (Daniel, 10.11.2026: la Produse ID-ul din tabel era greșit; contează cel la care duce linkul).
export function linkuriDinTab(valori: string[][]): Link[] {
  const linkuri: Link[] = [];
  for (const rand of valori) {
    if (/^link evaluari/i.test((rand[0] ?? "").trim())) break;
    const link = (rand[6] ?? "").trim();
    const seminar = (rand[1] ?? "").trim();
    if (!seminar || !/^https:\/\/\S+$/.test(link)) continue;
    linkuri.push({ seminar, link, id: idDinLink(link, rand[4] ?? ""), parola: (rand[5] ?? "").trim() });
  }
  return linkuri;
}

// Seminarul din bloc („Baza”) ↔ rândul din tabul de linkuri („Baza + ULT15MIN”).
export function linkPentru(seminar: string, linkuri: Link[]): Link | null {
  const cheie = fara(seminar);
  return linkuri.find((l) => fara(l.seminar) === cheie) ?? linkuri.find((l) => fara(l.seminar).startsWith(`${cheie} `)) ?? null;
}

// Cuvinte egale sau unul începe cu celălalt (min. 4 litere): „Cristi” ↔ „Cristian”, nu „Ana” ↔ „Anamaria”.
const acelasi = (a: string, b: string, exact = false) => a === b || (!exact && Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

// Același om: toate cuvintele numelui mai scurt (cel puțin 2) se regăsesc în celălalt, în orice ordine.
// exact: doar cuvinte identice (se încearcă întâi așa, ca „Gabriel Sima” să nu se încurce cu „Sima Gabriela”).
export function acelasiOm(a: string, b: string, exact = false): boolean {
  const [scurt, lung] = [cuvinte(a), cuvinte(b)].sort((x, y) => x.length - y.length);
  if (scurt.length < 2) return false;
  const liber = [...lung];
  for (const w of scurt) {
    const i = liber.findIndex((x) => acelasi(w, x, exact));
    if (i < 0) return false;
    liber.splice(i, 1);
  }
  return true;
}

export type Gasit =
  | { ok: true; nume: string; bl: string; seminar: string; link: string; id: string; parola: string; modul: string }
  | { ok: false; motiv: string; modul?: string };

export function cauta(date: Date_, cine: string): Gasit {
  const exacte = date.oameni.filter((om) => acelasiOm(cine, om.nume, true));
  const potriviri = exacte.length ? exacte : date.oameni.filter((om) => acelasiOm(cine, om.nume));
  const persoane = [...new Set(potriviri.map((om) => fara(om.nume)))];
  const seminare = [...new Set(potriviri.map((om) => om.seminar))];
  if (!potriviri.length) return { ok: false, motiv: `„${cine}” nu apare în niciun seminar din modulul ${date.modul}`, modul: date.modul };
  if (persoane.length > 1) return { ok: false, motiv: `„${cine}” se potrivește cu mai mulți oameni: ${potriviri.map((o) => o.nume).join(", ")}`, modul: date.modul };
  if (seminare.length > 1) return { ok: false, motiv: `${potriviri[0].nume} apare la mai multe seminare: ${seminare.join(", ")}`, modul: date.modul };
  const om = potriviri[0];
  const link = linkPentru(om.seminar, date.linkuri);
  if (!link) return { ok: false, motiv: `nu găsesc linkul seminarului ${om.seminar} în „ID-uri Referenti”`, modul: date.modul };
  if (!link.parola || !link.id) return { ok: false, motiv: `la seminarul ${om.seminar} lipsește ID-ul sau parola în „ID-uri Referenti”`, modul: date.modul };
  return { ok: true, nume: om.nume, bl: om.bl, seminar: om.seminar, link: link.link, id: link.id, parola: link.parola, modul: date.modul };
}

export function mesajLink(prenume: string, g: Extract<Gasit, { ok: true }>): string {
  return `Salut, ${prenume}! Linkul pentru seminarul ${g.seminar}: ${g.link}\nID: ${g.id} · Parolă: ${g.parola}\nSpor la seminar!`;
}
