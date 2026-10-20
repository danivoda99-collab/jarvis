"use client";

import { useEffect, useState } from "react";
import type { Vizual } from "@/lib/vizual";
import type { Module } from "./orb";
import Visual from "./visual";

// `module` leagă fereastra de cuvântul ei de pe sferă (AGENDA, SARCINI, BUGET, GMAIL).
export type Card = { module?: Module } & (
  | { id: string; kind: "summary"; title: string; text?: string; points?: string[]; table?: string[][]; vizual?: Vizual }
  | { id: string; kind: "list"; title: string; items: string[] }
  | { id: string; kind: "confirm"; title: string; details: string; recipient?: string; table?: string[][] }
);

export type Answer = "da" | "nu";

const KIND_LABEL: Record<Card["kind"], string> = {
  summary: "Rezumat",
  list: "Listă",
  confirm: "Confirmare",
};

const MODULE_LABEL: Record<Module, string> = { agenda: "Agenda", sarcini: "Sarcini", buget: "Buget", gmail: "Gmail" };

// Titlul se scrie literă cu literă, după ce fereastra s-a deschis.
function Typed({ text }: { text: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(text.length);
      return;
    }
    let count = 0;
    let timer = window.setTimeout(function step() {
      count += 1;
      setShown(count);
      if (count < text.length) timer = window.setTimeout(step, 16);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [text]);
  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length && <span className="caret" aria-hidden="true" />}
    </>
  );
}

function Table({ rows }: { rows: string[][] }) {
  if (rows.length < 2) return null;
  return (
    <div className="card-table">
      <table>
        <thead>
          <tr>
            {rows[0].map((cell, index) => (
              <th key={index}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Linkurile din text (un document în Drive, o pagină) se pot deschide cu o atingere; [titlu](url) devine „titlu”.
export function Linked({ line }: { line: string }) {
  const parts: React.ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s)]+)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(line.slice(last, at));
    const url = match[2] ?? match[3];
    parts.push(
      <a key={at} className="card-link" href={url} target="_blank" rel="noreferrer">
        {match[1] ?? (url.includes("docs.google.com") || url.includes("drive.google.com") ? "Deschide în Drive" : "Deschide linkul")}
      </a>,
    );
    last = at + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return <>{parts}</>;
}

// Textul de la laptop vine cu rânduri, liste și uneori markdown: îl arătăm pe blocuri, nu ca un singur paragraf.
// Cu un grafic sau tabel, primul paragraf stă deasupra lui, iar restul intră sub „Detalii”, închis.
function RichText({ text, only }: { text: string; only?: "lead" | "rest" }) {
  const clean = (line: string) => line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/, "").trim();
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      blocks.push({ list: false, lines: [] });
      continue;
    }
    const item = line.match(/^(?:[-•*]|\d+[.)])\s+(.*)$/);
    const last = blocks[blocks.length - 1];
    if (item) {
      if (last?.list) last.lines.push(clean(item[1]));
      else blocks.push({ list: true, lines: [clean(item[1])] });
    } else if (last && !last.list && last.lines.length) last.lines.push(clean(line));
    else blocks.push({ list: false, lines: [clean(line)] });
  }
  const shown = blocks.filter((block) => block.lines.length);
  if (only === "rest" && shown.length < 2) return null;
  const body = (
    <div className="card-rich">
      {(only === "lead" ? shown.slice(0, 1) : only === "rest" ? shown.slice(1) : shown)
        .map((block, index) =>
          block.list ? (
            <ul key={index} className="card-points">
              {block.lines.map((line, at) => (
                <li key={at}>
                  <Linked line={line} />
                </li>
              ))}
            </ul>
          ) : (
            <p key={index} className={index === 0 && only !== "rest" ? "card-text card-lead" : "card-text"}>
              {block.lines.map((line, at) => (
                <span key={at}>
                  {at > 0 && <br />}
                  <Linked line={line} />
                </span>
              ))}
            </p>
          ),
        )}
    </div>
  );
  // Un rest scurt („Restul: 4 conversații fără nimic urgent.”) rămâne la vedere.
  if (only !== "rest" || shown.slice(1).reduce((sum, block) => sum + block.lines.length, 0) <= 2) return body;
  return (
    <details className="card-more">
      <summary>Detalii</summary>
      {body}
    </details>
  );
}

export default function CardStack({
  cards,
  onClose,
  onAnswer,
}: {
  cards: Card[];
  onClose: (id: string) => void;
  onAnswer: (id: string, answer: Answer) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="cards" aria-live="polite">
      {cards.map((card) => (
        <article key={card.id} className={`card card-${card.kind}`} data-card-id={card.id} aria-label={card.title}>
          <span className="corner corner-a" aria-hidden="true" />
          <span className="corner corner-b" aria-hidden="true" />
          <header className="card-head">
            <span className="card-kind">
              {card.module ? `${MODULE_LABEL[card.module]} · ${KIND_LABEL[card.kind]}` : KIND_LABEL[card.kind]}
            </span>
            {card.kind !== "confirm" && (
              <button className="card-close" onClick={() => onClose(card.id)} aria-label="Închide">
                ×
              </button>
            )}
          </header>
          <h3 className="card-title">
            <Typed text={card.title} />
          </h3>

          {card.kind === "summary" && (
            <>
              {card.vizual ? (
                <>
                  {card.text && <RichText text={card.text} only="lead" />}
                  <Visual data={card.vizual} />
                  {card.text && <RichText text={card.text} only="rest" />}
                </>
              ) : (
                card.text && <RichText text={card.text} />
              )}
              {card.table && <Table rows={card.table} />}
              {card.points && card.points.length > 0 && (
                <ul className="card-points">
                  {card.points.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {card.kind === "list" && (
            <ol className="card-items">
              {card.items.map((item, index) => (
                <li key={index}>
                  <span className="card-index">{String(index + 1).padStart(2, "0")}</span>
                  {item}
                </li>
              ))}
            </ol>
          )}

          {card.kind === "confirm" && (
            <>
              {card.recipient && (
                <p className="card-recipient">
                  <span>Către</span>
                  {card.recipient}
                </p>
              )}
              {card.details && <p className="card-details">{card.details}</p>}
              {card.table && <Table rows={card.table} />}
              <p className="card-hint">Spune „Argus, accept” sau „Argus, refuz”.</p>
              <div className="card-actions">
                <button className="card-no" onClick={() => onAnswer(card.id, "nu")}>
                  Nu
                </button>
                <button className="card-yes" onClick={() => onAnswer(card.id, "da")}>
                  Da
                </button>
              </div>
            </>
          )}
        </article>
      ))}
    </div>
  );
}
