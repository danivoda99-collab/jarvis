"use client";

export type Card =
  | { id: string; kind: "summary"; title: string; text?: string; points?: string[] }
  | { id: string; kind: "list"; title: string; items: string[] }
  | { id: string; kind: "confirm"; title: string; details: string; recipient?: string };

export type Answer = "da" | "nu";

const KIND_LABEL: Record<Card["kind"], string> = {
  summary: "Rezumat",
  list: "Listă",
  confirm: "Confirmare",
};

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
        <article key={card.id} className={`card card-${card.kind}`}>
          <header className="card-head">
            <span className="card-kind">{KIND_LABEL[card.kind]}</span>
            {card.kind !== "confirm" && (
              <button className="card-close" onClick={() => onClose(card.id)} aria-label="Închide">
                ×
              </button>
            )}
          </header>
          <h3 className="card-title">{card.title}</h3>

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
              <p className="card-details">{card.details}</p>
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
