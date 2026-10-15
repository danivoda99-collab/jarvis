"use client";

import { useEffect, useState } from "react";
import type { Module } from "./orb";

// `module` leagă fereastra de cuvântul ei de pe sferă (AGENDA, SARCINI, BUGET, GMAIL).
export type Card = { module?: Module } & (
  | { id: string; kind: "summary"; title: string; text?: string; points?: string[] }
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
              {card.text && <p className="card-text">{card.text}</p>}
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
              {card.table && card.table.length > 1 && (
                <div className="card-table">
                  <table>
                    <thead>
                      <tr>
                        {card.table[0].map((cell, index) => (
                          <th key={index}>{cell}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {card.table.slice(1).map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((cell, index) => (
                            <td key={index}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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
