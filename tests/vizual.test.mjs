// Teste rapide pentru ce vine de la model sau din Sheet: „npm run check”.
import { test } from "node:test";
import assert from "node:assert/strict";
import { amount, cleanVizual } from "../lib/vizual.ts";

test("sume în orice format din Sheet", () => {
  assert.equal(amount("1,100.00"), 1100);
  assert.equal(amount("1.100,00"), 1100);
  assert.equal(amount("1,100"), 1100);
  assert.equal(amount("-25,5 lei"), -25.5);
  assert.equal(amount("1.5"), 1.5);
  assert.equal(amount(""), null);
});

test("punctele: urgentele sus, mesajul și sarcina păstrate", () => {
  const vizual = cleanVizual({
    puncte: [
      { titlu: "Info", nivel: "info" },
      { titlu: "Sun contabilul", nivel: "urgent", sarcina: "abc123" },
      { titlu: "Ioana", nivel: "important", mesaj: { catre: "Ioana", text: "Bravo!" } },
      { titlu: "", nivel: "urgent" },
    ],
  });
  assert.deepEqual(vizual.puncte.map((item) => item.titlu), ["Sun contabilul", "Ioana", "Info"]);
  assert.equal(vizual.puncte[0].sarcina, "abc123");
  assert.deepEqual(vizual.puncte[1].mesaj, { catre: "Ioana", text: "Bravo!" });
});

test("nivel necunoscut devine info, imagini doar https", () => {
  const vizual = cleanVizual({ puncte: [{ titlu: "X", nivel: "foarte" }], imagine: "javascript:alert(1)" });
  assert.equal(vizual.puncte[0].nivel, "info");
  assert.equal(vizual.imagine, undefined);
  assert.equal(cleanVizual({}), undefined);
});
