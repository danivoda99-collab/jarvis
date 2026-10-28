// Teste rapide pentru ce vine de la model sau din Sheet: „npm run check”.
import { test } from "node:test";
import assert from "node:assert/strict";
import { amount, budgetVizual, cleanVizual, unbudgeted } from "../lib/vizual.ts";

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

test("bugetul arată toate categoriile și ce e fără buget", () => {
  const table = [
    ["Categorie", "Buget", "Cheltuit", "Rămas", "%"],
    ...Array.from({ length: 15 }, (_, i) => [`C${i}`, "1,000", "500", "500", "50%"]),
    ["Ieșiri", "500", "715", "-215", "143%"],
    ["Altele", "0", "1,561", "-1,561"],
    ["Total", "16,500", "10,276", "5,724", "62%"],
  ];
  const vizual = budgetVizual(table);
  assert.equal(vizual.progres.length, 16);
  const lei = (n) => `${n.toLocaleString("ro-RO")} lei`;
  let cifre = Object.fromEntries(vizual.cifre.map((c) => [c.eticheta, c.valoare]));
  assert.equal(cifre["De plătit din buget"], lei(7500));
  assert.equal(cifre["Peste buget"], lei(1776));
  cifre = Object.fromEntries(budgetVizual(table, "20,000").cifre.map((c) => [c.eticheta, c.valoare]));
  assert.equal(cifre["Bani rămași"], lei(9724));
  assert.equal(cifre["Liber după plăți"], lei(2224));
  assert.deepEqual(unbudgeted(table), [["Fără buget", "Cheltuit"], ["Altele", "1,561 lei"]]);
});
