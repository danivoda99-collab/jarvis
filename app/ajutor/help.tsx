"use client";

import { useRef, useState, type FormEvent } from "react";

type Replica = { rol: "om" | "argus"; text: string };

const EXEMPLE = ["Unde trec analizele?", "Am greșit o cifră, cum corectez?", "Până când trebuie să raportez?", "Am uitat codul"];

export default function Help({ name }: { name: string }) {
  const [history, setHistory] = useState<Replica[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState(name);
  const listRef = useRef<HTMLDivElement>(null);

  async function ask(question: string, anunta = false) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    const before = history;
    setHistory([...before, { rol: "om", text }]);
    setDraft("");
    try {
      const response = await fetch("/api/ajutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intrebare: text, istoric: before, nume: who, anunta }),
      });
      const data = (await response.json().catch(() => ({}))) as { raspuns?: string; error?: string };
      setHistory((all) => [...all, { rol: "argus", text: data.raspuns || data.error || "N-am putut răspunde acum." }]);
    } catch {
      setHistory((all) => [...all, { rol: "argus", text: "Nu am conexiune. Verifică internetul și încearcă din nou." }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(draft);
  }

  // „Nu m-am descurcat”: ultima întrebare a omului ajunge la Daniel.
  const lastQuestion = [...history].reverse().find((item) => item.rol === "om")?.text ?? "";

  return (
    <main className="help">
      <header className="help-head">
        <span className="brand-mark">A</span>
        <div>
          <h1>Ajutor Team Vodă</h1>
          <p>Întreabă orice despre completarea aplicației. Nu vede cifrele tale și nu completează în locul tău.</p>
        </div>
      </header>
      <div className="help-list" ref={listRef}>
        {history.length === 0 && (
          <div className="help-examples">
            {EXEMPLE.map((example) => (
              <button key={example} onClick={() => void ask(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
        {history.map((item, index) => (
          <p key={index} className={`help-msg help-${item.rol}`}>
            {item.text}
          </p>
        ))}
        {busy && <p className="help-msg help-argus help-wait">Mă uit…</p>}
      </div>
      {lastQuestion && !busy && (
        <div className="help-escalate">
          {!name && <input value={who} onChange={(event) => setWho(event.target.value)} placeholder="Numele tău" aria-label="Numele tău" />}
          <button onClick={() => void ask(lastQuestion, true)}>Nu m-am descurcat, anunță-l pe Daniel</button>
        </div>
      )}
      <form className="help-form" onSubmit={submit}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Scrie întrebarea…" aria-label="Întrebarea ta" maxLength={1500} />
        <button type="submit" disabled={busy || !draft.trim()}>
          Întreabă
        </button>
      </form>
    </main>
  );
}
