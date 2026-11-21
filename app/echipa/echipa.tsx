"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, StareAgent } from "@/lib/echipa";
import type { Cerere } from "@/lib/cereri";
import { construiesteScena, type Scena, type Ton } from "./scena";
import "./echipa.css";

// Ecranul „Echipa”: sus ce ai de decis (cu textul exact și Da/Nu), în centru Argus cu agenții pe orbită,
// dedesubt „Ritmul zilei” (un rând pe agent) și detaliile agentului ales. Datele sunt cele reale, din /api/echipa
// și /api/cereri, reîmprospătate la 20 de secunde; când un agent raportează ceva nou, o cometă zboară spre Argus.

type Scor = { nota: number | null; ture: number; asteptate: number; erori: number; aprobate: number; refuzate: number; inUrma: boolean; istoric: (number | null)[] };
type AgentViu = Agent & { fire?: string; motto?: string; forma?: string; scor?: Scor | null };
type NotaTabla = { de: string; pentru: string; text: string; t: string };
type Stare = {
  acum: string;
  laptop: { cazut: boolean; minute?: number };
  probleme: string[];
  deDecis: number;
  agenti: AgentViu[];
  tabla?: NotaTabla[];
};
const notaText = (n: number | null | undefined) => (n === null || n === undefined ? "–" : n.toLocaleString("ro-RO", { maximumFractionDigits: 1 }));
const notaTon = (n: number | null | undefined) => (n === null || n === undefined ? "" : n >= 8 ? "bun" : n >= 6 ? "mediu" : "slab");

type Fisa = { rol: string; cand: string; orar: number[] | "ziua" | null; reguli: string[]; pornit: boolean };

// Ce face fiecare agent, când lucrează și ce nu are voie: scris după cum e făcut codul acum.
const FISE: Record<string, Fisa> = {
  paznic: {
    rol: "Verifică că Argus merge (laptopul, Google, Claude, OpenAI) și reconectează singur Google.",
    cand: "Din 10 în 10 minute, zi și noapte (cron-job.org)",
    orar: null,
    reguli: ["Te anunță o dată când ceva pică și o dată când își revine.", "Noaptea (23–08) alerta te așteaptă în aplicație."],
    pornit: true,
  },
  suport: {
    rol: "Prinde erorile din aplicația Team Vodă, caută cauza în copia codului și pregătește reparația.",
    cand: "Când apare o eroare",
    orar: null,
    reguli: ["Nu schimbă singur aplicația live: reparația o publici tu după Da.", "Vede doar erori și cifre de echipă, nu clienți."],
    pornit: true,
  },
  secretar: {
    rol: "Citește mailurile și pune termenele și cererile în Google Tasks, cu o zi înainte de termen.",
    cand: "La 9, 13 și 18",
    orar: [9, 13, 18],
    reguli: ["Doar citește și notează: nu răspunde nimănui.", "Un mail de la un client apare doar ca „un client”."],
    pornit: true,
  },
  manager: {
    rol: "PM-urile de azi și cele întârziate din traseul oamenilor noi; lunea, cu cine să faci 1:1.",
    cand: "Luni–vineri la 9",
    orar: [9],
    reguli: ["Doar citește din Team Vodă.", "Mesajele către oameni pleacă doar după Da-ul tău."],
    pornit: true,
  },
  evenimente: {
    rol: "Informări, invitații, materiale și postarea de vineri pentru grup, în stilul Voda.",
    cand: "În lucru: îl construim după ce alegi stilul",
    orar: null,
    reguli: ["Invitațiile și postările pleacă doar după Da-ul tău."],
    pornit: false,
  },
  whatsapp: {
    rol: "Citește grupurile de business și, dacă vrei, conversațiile cu echipa. Ce e urgent îți vine imediat.",
    cand: "La 30 de minute, 8–22, după ce o pornești",
    orar: "ziua",
    reguli: ["Doar citește; nu scrie nimic fără Da-ul tău.", "Pune chatul înapoi „necitit” după ce îl citește.", "Clienții și familia nu se deschid."],
    pornit: false,
  },
  imbunatatire: {
    rol: "Se uită ce a mers prost și ce ceri des, și propune corecturi pentru Argus.",
    cand: "În lucru: duminică seara, după ce îl pornim",
    orar: null,
    reguli: ["Doar propune; schimbările le aprobi tu."],
    pornit: false,
  },
  trader: {
    rol: "Test de daytrading pe hârtie: urmărește 60 de acțiuni mari din SUA, îți trimite semnalul (intrare, stop, țintă) și ține jurnalul cu rezultatul simulat.",
    cand: "Luni–vineri, din 5 în 5 minute cât e deschisă bursa din New York (16:30–23:00)",
    orar: null,
    reguli: ["Doar simulare: nu are cont la broker și nu poate cumpăra nimic.", "Cont de test 5.000 $, cel mult 50 $ pierdere pe tranzacție și 3 tranzacții pe zi.", "Bani reali doar dacă hotărăști tu, separat, după test."],
    pornit: true,
  },
};

const ORDINE = ["paznic", "suport", "imbunatatire", "secretar", "whatsapp", "manager", "evenimente", "trader"];
const TON: Record<StareAgent, Ton> = { lucreaza: "work", asteapta: "wait", ok: "ok", liber: "idle", pauza: "sleep", cazut: "urgent" };
const TEXT_STARE: Record<Ton, string> = { work: "Lucrează", wait: "Așteaptă Da", ok: "Totul merge", idle: "Liber", urgent: "Problemă", sleep: "În pauză" };
const CSS_TON: Record<Ton, string> = { work: "var(--e-flame)", wait: "var(--e-warn)", ok: "var(--e-ok)", idle: "var(--e-gold)", urgent: "var(--e-urgent)", sleep: "#6d6458" };

const oraRo = (d: Date) => {
  const p = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "numeric", hour12: false, timeZone: "Europe/Bucharest" }).formatToParts(d);
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
  return g("hour") + g("minute") / 60;
};
const fmt = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
const cand = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  const azi = new Date().toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" });
  const zi = d.toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" });
  const ora = d.toLocaleTimeString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
  return zi === azi ? `azi, ${ora}` : `${d.toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest", weekday: "long" })}, ${ora}`;
};

function urmatoarea(id: string, h: number) {
  const o = FISE[id]?.orar;
  if (!FISE[id]?.pornit) return "";
  if (o === "ziua") return h >= 8 && h < 22 ? "la 30 de minute" : "de la 8:00";
  if (!o) return FISE[id].cand.toLowerCase();
  const n = o.find((x) => x > h);
  return n !== undefined ? `următorul la ${fmt(n)}` : `mâine la ${fmt(o[0])}`;
}

// Cine a propus decizia: Santinela își scrie numele în rezultat; restul vin de la Argus.
const dela = (c: Cerere) => c.agent || (/^Santinela/.test(c.rezultat ?? "") ? "whatsapp" : /^Suport/i.test(c.rezultat ?? "") ? "suport" : "");

export default function Echipa() {
  const [stare, setStare] = useState<Stare | null>(null);
  const [cereri, setCereri] = useState<Cerere[]>([]);
  const [eroare, setEroare] = useState("");
  const [ales, setAles] = useState("secretar");
  const [raspunse, setRaspunse] = useState<Record<string, string>>({});
  const [h, setH] = useState(() => oraRo(new Date()));
  const [fara3d, setFara3d] = useState(false);
  const [intrebare, setIntrebare] = useState("");
  const [trimis, setTrimis] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const detaliiRef = useRef<HTMLElement>(null);
  const scena = useRef<Scena | null>(null);
  const ultime = useRef<Record<string, string>>({});
  const decizieVazuta = useRef(new Set<string>());

  const noapte = h < 8 || h >= 22;

  const agenti = useMemo(() => {
    const dupaId = new Map((stare?.agenti ?? []).map((a) => [a.id, a]));
    return ORDINE.map((id) => {
      const a = dupaId.get(id as Agent["id"]);
      const fisa = FISE[id];
      // Paznicul nu rulează până îl mutăm pe cron-job.org: nu-l arătăm „ok” doar pentru că n-a raportat probleme.
      const viata = { fire: a?.fire, motto: a?.motto, forma: a?.forma, scor: a?.scor ?? null };
      if (id === "paznic" && a?.stare === "liber") return { id, nume: a?.nume ?? id, ton: "idle" as Ton, face: "Oprit: cron-job.org nu l-a chemat de 30 de minute", ultima: a?.ultima, ...viata };
      const ton: Ton = a ? TON[a.stare] : "idle";
      // Agenții care n-au rulat încă niciodată nu pretind că sunt „liberi”: spun că nu sunt porniți.
      const face = !a?.ultima && !fisa.pornit && ton === "idle" ? "Încă nu e pornit" : a?.face || "Liber";
      return { id, nume: a?.nume ?? id, ton, face, ultima: a?.ultima, ...viata };
    });
  }, [stare]);

  const decizii = useMemo(() => cereri.filter((c) => c.status === "așteaptă confirmare"), [cereri]);

  // Jurnalul „live”: ce au făcut agenții și laptopul în ultimele 24 de ore, cel mai nou primul.
  const jurnal = useMemo(() => {
    const zi = Date.now() - 24 * 3600_000;
    const dinAgenti = agenti
      .filter((a) => a.ultima && Date.parse(a.ultima) > zi && a.face && a.face !== "Liber")
      .map((a) => ({ t: a.ultima!, id: a.id, nume: a.nume, ton: a.ton, text: a.face }));
    const dinCereri = cereri
      .filter((c) => (c.status === "gata" || c.status === "eroare") && Date.parse(c.actualizat) > zi)
      .map((c) => ({ t: c.actualizat, id: "", nume: "Laptopul", ton: (c.status === "gata" ? "ok" : "urgent") as Ton, text: c.titlu }));
    const numeDe = (id: string) => (id === "toti" ? "toți" : (agenti.find((x) => x.id === id)?.nume ?? id));
    const dinTabla = (stare?.tabla ?? [])
      .filter((n) => Date.parse(n.t) > zi)
      .map((n) => ({ t: n.t, id: n.de, nume: `${numeDe(n.de)} → ${numeDe(n.pentru)}`, ton: "idle" as Ton, text: n.text }));
    return [...dinAgenti, ...dinCereri, ...dinTabla].sort((a, b) => b.t.localeCompare(a.t)).slice(0, 3);
  }, [agenti, cereri, stare]);

  const incarca = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([fetch("/api/echipa", { cache: "no-store" }), fetch("/api/cereri", { cache: "no-store" })]);
      if (r1.status === 401 || r2.status === 401) {
        window.location.reload();
        return;
      }
      if (!r1.ok) throw new Error();
      const s = (await r1.json()) as Stare;
      const c = r2.ok ? (((await r2.json()) as { cereri?: Cerere[] }).cereri ?? []) : [];
      // Un agent cu o tură nouă de la ultima citire trimite o cometă spre Argus.
      for (const a of s.agenti) {
        const inainte = ultime.current[a.id];
        if (a.ultima && inainte !== undefined && inainte !== a.ultima) scena.current?.raport(a.id);
        ultime.current[a.id] = a.ultima ?? "";
      }
      for (const d of c.filter((x) => x.status === "așteaptă confirmare")) {
        if (!decizieVazuta.current.has(d.id)) {
          if (decizieVazuta.current.size) scena.current?.raport(dela(d) || "secretar");
          decizieVazuta.current.add(d.id);
        }
      }
      setStare(s);
      setCereri(c);
      setEroare("");
    } catch {
      setEroare("Nu ajung la Argus acum. Încerc din nou în câteva secunde.");
    }
  }, []);

  useEffect(() => {
    void incarca();
    const id = window.setInterval(() => {
      if (!document.hidden) void incarca();
    }, 20_000);
    const ceas = window.setInterval(() => setH(oraRo(new Date())), 60_000);
    const vizibil = () => {
      if (!document.hidden) void incarca();
    };
    document.addEventListener("visibilitychange", vizibil);
    return () => {
      window.clearInterval(id);
      window.clearInterval(ceas);
      document.removeEventListener("visibilitychange", vizibil);
    };
  }, [incarca]);

  const alege = useCallback((id: string) => {
    setAles(id);
    setTrimis("");
    setIntrebare("");
    scena.current?.alege(id);
  }, []);

  // Sfera se construiește o singură dată, după primele date; apoi doar se recolorează.
  const gata = Boolean(stare);
  useEffect(() => {
    if (!gata || scena.current || !stageRef.current || !labelsRef.current) return;
    try {
      scena.current = construiesteScena(
        stageRef.current,
        labelsRef.current,
        agenti.map((a) => ({ id: a.id, nume: a.nume, ton: a.ton, eticheta: a.face, forma: a.forma })),
        (id) => {
          alege(id);
          detaliiRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        },
      );
      scena.current.alege(ales);
      // Cel mai recent agent raportează o dată la deschidere, ca să se vadă cum arată.
      const recent = [...agenti].filter((a) => a.ultima).sort((a, b) => (b.ultima ?? "").localeCompare(a.ultima ?? ""))[0];
      if (recent) window.setTimeout(() => scena.current?.raport(recent.id), 900);
    } catch {
      setFara3d(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gata]);

  useEffect(() => () => scena.current?.opreste(), []);

  useEffect(() => {
    scena.current?.actualizeaza(agenti.map((a) => ({ id: a.id, nume: a.nume, ton: a.ton, eticheta: a.face })));
  }, [agenti]);

  useEffect(() => {
    scena.current?.noapte(noapte);
  }, [noapte, gata]);

  async function raspunde(c: Cerere, da: boolean) {
    setRaspunse((r) => ({ ...r, [c.id]: "…" }));
    try {
      const r = await fetch("/api/cereri", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, status: da ? "confirmată" : "refuzată" }),
      });
      const mesaj = r.ok ? (da ? "Confirmat. Laptopul îl trimite acum." : "Refuzat. Nu pleacă nimic.") : r.status === 409 ? "S-a schimbat între timp." : "N-a mers. Mai încearcă.";
      setRaspunse((x) => ({ ...x, [c.id]: mesaj }));
      if (r.ok && da) scena.current?.raport(dela(c) || "secretar");
      window.setTimeout(() => void incarca(), 1500);
    } catch {
      setRaspunse((x) => ({ ...x, [c.id]: "N-a mers. Mai încearcă." }));
    }
  }

  async function intreaba() {
    const text = intrebare.trim();
    if (!text) return;
    const nume = agenti.find((a) => a.id === ales)?.nume ?? "agent";
    setTrimis("Trimit…");
    try {
      const r = await fetch("/api/cereri", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titlu: `Întrebare pentru ${nume}`.slice(0, 120),
          cerere: `Daniel întreabă agentul „${nume}” (${FISE[ales]?.rol ?? ""}): ${text}\nRăspunde scurt, ca acel agent, din ce știi și din ce poți verifica acum. Nu trimiți nimic nimănui.`,
        }),
      });
      setTrimis(r.ok ? "Am trimis. Răspunsul vine în Lucrări și ca notificare." : "N-a mers. Mai încearcă.");
      if (r.ok) setIntrebare("");
    } catch {
      setTrimis("N-a mers. Mai încearcă.");
    }
  }

  const a = agenti.find((x) => x.id === ales) ?? agenti[0];
  const fisa = FISE[a.id];
  const tonAles: Ton = noapte && a.id !== "paznic" && (a.ton === "idle" || a.ton === "ok") ? "sleep" : a.ton;
  const alerta = stare?.laptop.cazut
    ? { titlu: "Laptopul nu răspunde", text: `De ${stare.laptop.minute ?? 20} de minute. Agenții de pe el sunt în pauză până revine.` }
    : stare?.probleme.length
      ? { titlu: "Paznicul", text: stare.probleme[0] }
      : null;

  return (
    <div className="echipa">
      <div className="e-wrap">
        <header className="e-head">
          <a className="e-back" href="/">
            ← Argus
          </a>
          <h1>
            ECHIPA <span>ARGUS</span>
          </h1>
          <span className="e-tag">{stare ? `acum ${fmt(h)}` : "se încarcă…"}</span>
        </header>

        {eroare && <p className="e-err">{eroare}</p>}

        {decizii.length > 0 && (
          <section className="e-decide" aria-labelledby="e-decide-h">
            <h2 id="e-decide-h">De decis de tine · {decizii.length}</h2>
            <ul>
              {decizii.map((c) => (
                <li key={c.id}>
                  <div className="e-dtext">
                    <b>{c.confirmare?.titlu || c.titlu}</b>
                    {c.confirmare?.destinatar && <div className="e-from">către {c.confirmare.destinatar}</div>}
                    {c.confirmare?.text && <p className="e-exact">{c.confirmare.text}</p>}
                  </div>
                  <div className="e-btns">
                    {raspunse[c.id] ? (
                      <span className="e-from">{raspunse[c.id]}</span>
                    ) : (
                      <>
                        <button className="e-btn yes" type="button" onClick={() => void raspunde(c, true)}>
                          Da
                        </button>
                        <button className="e-btn" type="button" onClick={() => void raspunde(c, false)}>
                          Nu
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className={`e-stage${noapte ? " night" : ""}`} ref={stageRef}>
          <div className="e-labels" ref={labelsRef} />
          {jurnal.length > 0 && (
            <ol className="e-feed" aria-label="Ce s-a întâmplat ultima dată">
              {jurnal.map((j) => (
                <li key={`${j.t}-${j.nume}`}>
                  <time>{fmt(oraRo(new Date(j.t)))}</time>
                  <b style={{ color: CSS_TON[j.ton] }}>{j.nume}</b> {j.text}
                </li>
              ))}
            </ol>
          )}
          <div className={`e-alert${alerta ? " on" : ""}`} role="status">
            {alerta && (
              <>
                <b>{alerta.titlu}</b>
                <p>{alerta.text}</p>
              </>
            )}
          </div>
          {noapte && <div className="e-nightnote">Noaptea · agenții dorm</div>}
          {fara3d && <div className="e-fallback">Sfera 3D nu se poate afișa pe acest telefon. Mai jos vezi tot.</div>}
          {!stare && !fara3d && <div className="e-fallback">Se încarcă echipa…</div>}
        </div>

        <section className="e-rhythm" aria-labelledby="e-rh">
          <div className="e-rhythm-head">
            <h2 id="e-rh">Ritmul zilei</h2>
            <span className="e-from">acum {fmt(h)}</span>
          </div>
          {agenti.map((x) => {
            const f = FISE[x.id];
            const t: Ton = noapte && x.id !== "paznic" && (x.ton === "idle" || x.ton === "ok") ? "sleep" : x.ton;
            const urm = urmatoarea(x.id, h);
            return (
              <button type="button" key={x.id} className={`e-row ${t}`} aria-pressed={x.id === ales} onClick={() => alege(x.id)}>
                <span className="e-who">
                  <span className={`e-dot ${t}`} />
                  <b>{x.nume}</b>
                  {x.scor?.nota !== null && x.scor?.nota !== undefined && (
                    <span className={`e-nota ${notaTon(x.scor.nota)}`} title="Nota săptămânii">
                      {notaText(x.scor.nota)}
                    </span>
                  )}
                </span>
                <span className="e-now">
                  <span>
                    {x.face}
                    {urm && <em className="e-from"> · {urm}</em>}
                  </span>
                </span>
                <span className="e-track">
                  {f.orar === "ziua" && <span className="e-dash" style={{ left: `${(8 / 24) * 100}%`, width: `${(14 / 24) * 100}%` }} />}
                  {Array.isArray(f.orar) &&
                    f.orar.map((o) => {
                      const nx = (f.orar as number[]).find((y) => y > h);
                      return <span key={o} className={`e-tick${o < h ? " done" : ""}${o === nx ? " next" : ""}`} style={{ left: `${(o / 24) * 100}%` }} title={fmt(o)} />;
                    })}
                  <span className="e-nowline" style={{ left: `${(h / 24) * 100}%` }} />
                </span>
              </button>
            );
          })}
          <div className="e-hours">
            <div />
            <div>
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>24</span>
            </div>
          </div>
        </section>

        <section className="e-detail" ref={detaliiRef} aria-live="polite">
          <h2>
            {a.nume} <span className={`e-pill ${tonAles}`}>{TEXT_STARE[tonAles]}</span>
            <span className="e-from">{fisa.cand}</span>
          </h2>
          <p className="e-role">{fisa.rol}</p>
          {a.fire && (
            <p className="e-fire">
              <span className="e-from">{a.fire}</span>
              {a.motto && <q>{a.motto}</q>}
            </p>
          )}
          <div className="e-card">
            <div className="e-chead">
              <span>Acum</span>
              <span>{a.ultima ? `ultima tură ${cand(a.ultima)}` : "n-a rulat încă"}</span>
            </div>
            <p className="e-lead">{a.face}</p>
          </div>
          <div className="e-card">
            <div className="e-chead">
              <span>Nota săptămânii</span>
              <span>
                ultimele 3: {(a.scor?.istoric ?? [null, null, null]).map((n) => notaText(n)).join(" · ")}
              </span>
            </div>
            {a.scor && a.scor.nota !== null ? (
              <>
                <p className="e-lead">
                  <span className={`e-nota mare ${notaTon(a.scor.nota)}`}>{notaText(a.scor.nota)}</span> din 10
                </p>
                <p className="e-from">
                  {a.scor.asteptate ? `${a.scor.ture} ture din ${a.scor.asteptate}` : `${a.scor.ture} ture`} · {a.scor.erori} erori · {a.scor.aprobate} propuneri aprobate, {a.scor.refuzate} refuzate
                </p>
                {a.scor.inUrma && <p className="e-warn">E sub 6 de trei săptămâni la rând. Îmbunătățirea îți propune ce schimbăm la el.</p>}
              </>
            ) : (
              <p className="e-from">Încă n-are notă: n-a avut nicio tură săptămâna asta.</p>
            )}
          </div>
          {(stare?.tabla ?? []).some((n) => n.de === a.id || n.pentru === a.id || n.pentru === "toti") && (
            <div className="e-card">
              <div className="e-chead">
                <span>Tabla echipei</span>
                <span>notele cu colegii</span>
              </div>
              <ul className="e-tabla">
                {(stare?.tabla ?? [])
                  .filter((n) => n.de === a.id || n.pentru === a.id || n.pentru === "toti")
                  .slice(0, 5)
                  .map((n) => (
                    <li key={`${n.t}${n.de}`}>
                      <span className="e-from">
                        {cand(n.t)} · {n.de === a.id ? `către ${agenti.find((x) => x.id === n.pentru)?.nume ?? "toți"}` : `de la ${agenti.find((x) => x.id === n.de)?.nume ?? n.de}`}
                      </span>
                      {n.text}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {decizii.filter((c) => dela(c) === a.id).length > 0 && (
            <p className="e-from">Așteaptă Da-ul tău: {decizii.filter((c) => dela(c) === a.id).length} (sus, la „De decis”)</p>
          )}
          <div className="e-ask">
            <span className="e-from">Întreabă-l direct pe {a.nume}</span>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void intreaba();
              }}
            >
              <input value={intrebare} onChange={(e) => setIntrebare(e.target.value)} placeholder={`De exemplu: „Ce ai găsit azi?”`} maxLength={300} enterKeyHint="send" />
              <button type="submit" className="e-btn yes" disabled={!intrebare.trim()}>
                Trimite
              </button>
            </form>
            {trimis && <p className="e-ans">{trimis}</p>}
          </div>
          <ul className="e-rules">
            {fisa.reguli.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>

        <p className="e-foot">Nimic nu pleacă fără Da-ul tău, fără date de clienți OVB, fără plăți, fără ștergeri definitive.</p>
      </div>
    </div>
  );
}
