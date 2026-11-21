// Scriptul pentru aplicația Scriptable de pe iPhone: citește starea echipei și desenează widgetul
// (ecran principal: mic, mediu, mare; ecran blocat: cerc, dreptunghi, rând). Fără internet arată ultimele date, cu ora lor.

export function scriptWidget(adresa: string, cheie: string): string {
  return `// Argus · widgetul echipei. Făcut de Argus; nu trebuie modificat.
const URL_STARE = ${JSON.stringify(`${adresa}/api/echipa?cheie=${cheie}`)};
const URL_APP = ${JSON.stringify(`${adresa}/echipa`)};
const FLACARA = new Color("#ff6a13"), AUR = new Color("#f0d28a"), GALBEN = new Color("#f2b33d"), VERDE = new Color("#7cc79a"), ROSU = new Color("#ff5a4f"), GRI = new Color("#9c907f"), FILDES = new Color("#f4ecd8");
const CULOARE = { lucreaza: FLACARA, asteapta: GALBEN, ok: VERDE, liber: GRI, pauza: new Color("#5a4f45"), cazut: ROSU };

let d, offline = false;
try {
  const r = new Request(URL_STARE); r.timeoutInterval = 12;
  d = await r.loadJSON();
  if (!d || !d.agenti) throw new Error("fara date");
  Keychain.set("argus_echipa", JSON.stringify(d));
} catch (e) {
  offline = true;
  d = Keychain.contains("argus_echipa") ? JSON.parse(Keychain.get("argus_echipa")) : null;
}

function cand(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "acum";
  if (m < 60) return "acum " + m + " min";
  const h = Math.round(m / 60);
  return h < 24 ? "acum " + h + " h" : "acum " + Math.round(h / 24) + " zile";
}
const n = d ? d.deDecis : 0;
const cazut = d && (d.laptop.cazut || d.probleme.length);
const lucreaza = d ? d.agenti.filter(a => a.stare === "lucreaza" || a.stare === "asteapta")[0] : null;
const fam = config.widgetFamily || "medium";
const w = new ListWidget();
w.url = URL_APP;
w.refreshAfterDate = new Date(Date.now() + 5 * 60000);

function txt(stack, s, size, color, bold) {
  const t = stack.addText(s);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  if (color) t.textColor = color;
  t.lineLimit = 1;
  return t;
}

if (!d) {
  txt(w, "Argus", 14, AUR, true);
  txt(w, "Fără date încă. Verifică internetul.", 11, GRI);
} else if (fam === "accessoryInline") {
  txt(w, cazut ? "⚠︎ Argus: " + (d.probleme[0] || "laptopul nu răspunde") : "Argus · " + (n ? n + " Da te așteaptă" : "totul liniștit"), 12);
} else if (fam === "accessoryCircular") {
  w.addAccessoryWidgetBackground = true;
  const s = w.addStack(); s.layoutVertically(); s.centerAlignContent();
  const a = s.addStack(); a.addSpacer(); txt(a, cazut ? "!" : n ? String(n) : "✓", 20, null, true); a.addSpacer();
  const b = s.addStack(); b.addSpacer(); txt(b, cazut ? "laptop" : "de Da", 8); b.addSpacer();
} else if (fam === "accessoryRectangular") {
  txt(w, cazut ? "! " + (d.probleme[0] || "Laptopul Argus") : lucreaza ? lucreaza.nume : "Totul liniștit", 13, null, true);
  txt(w, cazut ? "Atinge pentru detalii" : lucreaza ? lucreaza.face : (n ? n + " așteaptă Da" : "Paznicul e de pază"), 12);
  txt(w, (offline ? "⌀ " : "") + cand(d.acum), 11);
} else {
  w.backgroundColor = new Color("#0e0a07");
  w.setPadding(12, 14, 12, 14);
  const hd = w.addStack(); hd.centerAlignContent();
  txt(hd, "Echipa Argus", fam === "small" ? 13 : 15, AUR, true);
  hd.addSpacer();
  if (fam !== "small") txt(hd, cazut ? "Atenție" : n ? n + " așteaptă Da" : "Nimic de decis", 11, cazut ? ROSU : n ? GALBEN : VERDE, true);
  w.addSpacer(fam === "small" ? 6 : 8);
  if (fam === "small") {
    txt(w, cazut ? "!" : n ? String(n) : "✓", 38, cazut ? ROSU : n ? GALBEN : VERDE, true);
    const sub = w.addText(cazut ? (d.probleme[0] || "Laptopul nu răspunde") : n ? d.decizii.join(" · ") : "Totul liniștit");
    sub.font = Font.systemFont(11); sub.textColor = GRI; sub.lineLimit = 2;
  } else {
    const max = fam === "large" ? d.agenti.length : 6;
    for (const a of d.agenti.slice(0, max)) {
      const r = w.addStack(); r.centerAlignContent();
      const dot = r.addText("●"); dot.font = Font.systemFont(9); dot.textColor = CULOARE[a.stare] || GRI;
      r.addSpacer(6);
      const nm = txt(r, a.nume, 11.5, FILDES, true); 
      r.addSpacer(8);
      txt(r, a.face, 11.5, GRI);
      r.addSpacer();
      w.addSpacer(3);
    }
  }
  w.addSpacer();
  txt(w, (offline ? "⌀ fără internet · " : "actualizat ") + cand(d.acum), 9.5, new Color("#7a6f62"));
}

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();
`;
}
