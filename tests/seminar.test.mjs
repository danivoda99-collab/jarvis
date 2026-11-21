// Linkul de seminar: cine e la ce seminar și ce text pleacă (date luate din Sheet-ul real, 10.11.2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { acelasiOm, cauta, idDinLink, linkuriDinTab, mesajLink, numeSeminar, oameniDinTab, tabulCurent } from "../lib/seminar-reguli.ts";

const TAB = [
  ["", "Unde Prezent?", "Nume Prenume Colaborator", "BL", "Nume Prenume Lider (CHS+)", "Seminar 1", "Prezent?", "Training 1"],
  [" ", "", "", "", "", "SEMINAR BAZA"],
  ["9", "OL", "Sima Gabriel", "Voda", "Voda", "OL"],
  ["74", "FB", "Giurea Paula-Alexandra", "Dobre", "Dobre Andreea", "FB"],
  ["180", "OL", "Giurea Paula-Alexandra", "Dobre", "Popescu Razvan", "OL"],
  ["22", "OL", "Vornicu Iulia Mariana", "Voda", "Voda", "OL"],
  ["FB", "77", "", "", "", "70", "0", "14"],
  ["Nr. Crt.", "Locatia", "Nume Prenume Trainer", "Nume BL", "Observatii", "SB1", "", "TB1"],
  ["1", "FB", "Ciorobea Roland", "Ciorobea Roland", "referent"],
  [],
  ["1", "FBv", "RADULESCU ELENA", "IANCU Isabell"],
  ["", "", "", "", "", "SEMINAR DEZVOLTARE"],
  ["21", "OL", "Enache Andreea", "Voda", "Voda", "OL"],
  ["", "", "", "", "", "SEMINAR PROFESIE"],
  ["4", "FB", "Tutu Iulia", "Voda", "Voda", "FB"],
  ["41", "OL", "Miclea Cristian", "Voda", "Voda", "OL"],
  ["", "", "", "", "", "SEMINAR PRODUSE"],
  ["1", "OL", "Sima Gabriela", "Iancu", "X", "OL"],
  ["", "", "", "", "", "TO BE GST"],
  ["1", "OL", "Dolgae Cornel", "Voda", "Voda"],
];
const IDS = [
  ["Data", "Seminarii de BAZA", "FIZIC in BIROU", "ONLINE pe ZOOM", "ID ZOOM", "PASS ZOOM", "LINK ZOOM"],
  ["Seminar (Marti) + Training (Sambata)", "Baza + ULT15MIN", "a", "b", "255 033 4934", "DS8VDi", "https://ovb.zoom.us/j/2550334934?pwd=QzBEVXFGSkdWbFlJdXNEd0JQQU5YZz09"],
  ["Seminar (Marti) + Training (Sambata)", "Dezvoltare", "a", "b", "938 348 9679", "GG7C2J", "https://ovb.zoom.us/j/9383489679?pwd=Xoew"],
  ["Seminar (Marti) + Training (Sambata)", "Profesie", "a", "b", "264 623 7065", "123456", "https://ovb.zoom.us/j/2646237065?pwd=T214"],
  ["Seminar (Marti) + Training (Sambata)", "Produse", "a", "b", "434 348 3507", "153083", "https://ovb.zoom.us/j/4333483507?pwd=QmJp"],
  ["Seminar (Marti) ", "To be GST", "a", "b", "713 449 7923", "110399", "https://ovb.zoom.us/j/7134497923?pwd=RGgy"],
  ["Seminar (Marti)", "To be BL", "a", "b", "309 912 8527", "103851", "https://ovb.zoom.us/my/iulian.cosmin.mogos?pwd=b0VI"],
  ["LINK EVALUARI ACTIVITATI", "GRIGORE DRAGOS", "COMISIA DE EVALUARE", "", "248 331 6059", "620545", "https://ovb.zoom.us/j/2483316059?pwd=Szly"],
];
const date = { modul: "05.11.2026", oameni: oameniDinTab(TAB), linkuri: linkuriDinTab(IDS) };

test("modulul curent: cel mai nou tab după data + 5 zile, 16:00", () => {
  const tabs = ["Organizare seminare", "NU COMPLETA IN EL", "ID-uri Referenti", "05.11.2026", "15.10.2026", "13.08.2026.", "TEST", "~bk_op1_05.11.2026"];
  assert.equal(tabulCurent(tabs, new Date("2026-11-10T15:00:00Z")), "05.11.2026");
  assert.equal(tabulCurent(tabs, new Date("2026-11-10T10:00:00Z")), "15.10.2026");
  assert.equal(tabulCurent([...tabs, "26.11.2026"], new Date("2026-11-20T10:00:00Z")), "05.11.2026");
});

test("numele seminarelor și ID-ul din link", () => {
  assert.equal(numeSeminar("SEMINAR BAZA"), "Baza");
  assert.equal(numeSeminar("TO BE GST"), "To be GST");
  assert.equal(numeSeminar("SEMINAR MANAGEMENT PM"), "Management PM");
  assert.equal(numeSeminar("Seminar 1"), null);
  assert.equal(idDinLink("https://ovb.zoom.us/j/4333483507?pwd=x", "434 348 3507"), "433 348 3507");
  assert.equal(idDinLink("https://ovb.zoom.us/my/iulian?pwd=x", "309 912 8527"), "309 912 8527");
});

test("trainerii și rândurile de total nu sunt oameni la seminar; evaluările nu sunt seminar", () => {
  assert.ok(!date.oameni.some((o) => /Ciorobea|RADULESCU/.test(o.nume)));
  assert.ok(!date.linkuri.some((l) => /GRIGORE/.test(l.seminar)));
  assert.equal(date.linkuri.length, 6);
});

test("potrivirea numelor", () => {
  assert.ok(acelasiOm("Cristi Miclea", "Miclea Cristian"));
  assert.ok(acelasiOm("Iulia Vornicu", "Vornicu Iulia Mariana"));
  assert.ok(acelasiOm("Gabriel Sima 🔥", "Sima Gabriel"));
  assert.ok(!acelasiOm("Gabi", "Sima Gabriel"));
  assert.ok(!acelasiOm("Iulia Tutu", "Vornicu Iulia Mariana"));
});

test("textul exact, cu ID-ul din link la Produse", () => {
  const g = cauta(date, "Gabriel Sima");
  assert.equal(g.ok, true);
  assert.equal(mesajLink("Gabriel", g), "Salut, Gabriel! Linkul pentru seminarul Baza: https://ovb.zoom.us/j/2550334934?pwd=QzBEVXFGSkdWbFlJdXNEd0JQQU5YZz09\nID: 255 033 4934 · Parolă: DS8VDi\nSpor la seminar!");
  const p = cauta(date, "Gabriela Sima");
  assert.equal(p.ok && p.seminar, "Produse"); // potrivirea exactă are prioritate față de „Gabriel”
  assert.equal(p.ok && p.id, "433 348 3507");
  assert.equal(cauta(date, "Gabi Sima").ok, false); // „Gabi” e prea scurt ca să fie sigur
  const m = cauta(date, "Cristi Miclea");
  assert.equal(m.ok && m.seminar, "Profesie");
  assert.equal(cauta(date, "Dolgae Cornel").ok && cauta(date, "Dolgae Cornel").seminar, "To be GST");
});

test("nu ghicește: negăsit sau același om la două seminare", () => {
  assert.equal(cauta(date, "Popescu Ion").ok, false);
  assert.equal(cauta(date, "Paula Giurea").ok, true); // de două ori, dar la același seminar
  const dublu = { ...date, oameni: [...date.oameni, { nume: "Tutu Iulia", bl: "Voda", seminar: "Baza" }] };
  assert.equal(cauta(dublu, "Iulia Tutu").ok, false);
});
