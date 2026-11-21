"use client";

import { useEffect, useState } from "react";

// Pagina de instalare a widgetului: un singur buton „Copiază scriptul”, apoi pașii din Scriptable.
// Scriptul vine de la server cu cheia widgetului deja pusă; „Schimbă cheia” îl face pe cel vechi să nu mai vadă nimic.

const PASI = [
  "Instalează Scriptable din App Store (gratuit).",
  "Apasă mai sus „Copiază scriptul”.",
  "În Scriptable apasă „+”, lipește, apoi apasă pe titlu și numește-l „Argus”. Apasă ▶ o dată: trebuie să apară echipa.",
  "Ecranul principal: ține apăsat pe un loc gol, „+”, Scriptable, alege mărimea, „Adaugă widget”. Apoi ține apăsat pe widget, „Editează widgetul”, la Script alege „Argus”.",
  "Ecranul blocat: ține apăsat pe ecranul blocat, „Personalizează”, „Ecran blocat”, atinge zona de sub ceas și adaugă cercul sau dreptunghiul Scriptable; la fiecare alege scriptul „Argus”.",
];

export default function WidgetSetup() {
  const [script, setScript] = useState("");
  const [stare, setStare] = useState<"incarc" | "gata" | "neautentificat" | "eroare">("incarc");
  const [copiat, setCopiat] = useState(false);

  async function incarca(noua = false) {
    setCopiat(false);
    try {
      const r = await fetch("/api/echipa/widget", { method: noua ? "POST" : "GET", cache: "no-store" });
      if (r.status === 401) return setStare("neautentificat");
      const data = (await r.json()) as { script?: string };
      if (!data.script) return setStare("eroare");
      setScript(data.script);
      setStare("gata");
    } catch {
      setStare("eroare");
    }
  }

  useEffect(() => {
    void incarca();
  }, []);

  async function copiaza() {
    try {
      await navigator.clipboard.writeText(script);
      setCopiat(true);
    } catch {
      setCopiat(false);
    }
  }

  return (
    <main style={{ minHeight: "100dvh", background: "#0a0807", color: "#f4ecd8", fontFamily: "system-ui, -apple-system, sans-serif", padding: "28px 18px 48px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", display: "grid", gap: 18 }}>
        <div>
          <div style={{ font: "500 11px ui-monospace, monospace", letterSpacing: ".3em", textTransform: "uppercase", color: "#9c907f" }}>Argus pe iPhone</div>
          <h1 style={{ margin: "4px 0 0", font: "600 38px Georgia, serif" }}>
            Widgetul <em style={{ color: "#d4a64a", fontWeight: 500 }}>echipei</em>
          </h1>
          <p style={{ color: "#9c907f", margin: "8px 0 0" }}>Vezi pe ecranul telefonului cine lucrează și câte lucruri așteaptă Da-ul tău. Se reîmprospătează singur, de obicei la 5–15 minute.</p>
        </div>
        {stare === "neautentificat" && <p style={{ color: "#f2b33d" }}>Deschide întâi Argus și intră cu codul, apoi revino aici.</p>}
        {stare === "eroare" && <p style={{ color: "#ff5a4f" }}>Nu am putut pregăti scriptul. Mai încearcă peste un minut.</p>}
        {stare === "gata" && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" onClick={copiaza} style={{ font: "600 16px system-ui", background: "#d4a64a", color: "#0a0807", border: 0, borderRadius: 10, padding: "12px 20px", cursor: "pointer" }}>
              {copiat ? "Copiat ✓" : "Copiază scriptul"}
            </button>
            <button type="button" onClick={() => void incarca(true)} style={{ font: "500 13px system-ui", background: "transparent", color: "#9c907f", border: "1px solid #2a221b", borderRadius: 10, padding: "10px 14px", cursor: "pointer" }}>
              Schimbă cheia
            </button>
          </div>
        )}
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 10, color: "#d9cfbb" }}>
          {PASI.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
        <p style={{ color: "#9c907f", fontSize: 13, margin: 0 }}>
          „Schimbă cheia” dacă ai pierdut telefonul sau ai dat scriptul cuiva: widgetul vechi nu mai vede nimic, iar tu copiezi din nou scriptul. Widgetul doar citește; nu are butoane de Da și nu primește date despre clienți.
        </p>
      </div>
    </main>
  );
}
