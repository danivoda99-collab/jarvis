// Creierul pe laptop: cum pleacă conversația spre laptop și cum se citește răspunsul lui (cu uneltele telefonului).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReply, parseSse, renderTurn, toolProtocol, visiblePart } from "../lib/creier-format.ts";

const TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  { name: "agenda_citeste", description: "Citește agenda", input_schema: { type: "object", properties: { zile: { type: "number" } } } },
  { name: "cere_confirmare", description: "Fereastra Da/Nu", input_schema: { type: "object", properties: { text: { type: "string" } } } },
];
let n = 0;
const id = () => `toolu_lap_${++n}`;

test("protocolul descrie doar uneltele telefonului, nu căutarea de pe server", () => {
  const text = toolProtocol(TOOLS);
  assert.match(text, /agenda_citeste/);
  assert.match(text, /cere_confirmare/);
  assert.doesNotMatch(text, /"web_search"/);
});

test("răspuns simplu: doar text, end_turn", () => {
  const reply = parseReply("<spoken>Hi</spoken><ro>Salut</ro>", TOOLS, id);
  assert.equal(reply.stop_reason, "end_turn");
  assert.deepEqual(reply.content, [{ type: "text", text: "<spoken>Hi</spoken><ro>Salut</ro>" }]);
});

test("răspuns cu unelte: textul rămâne, blocul devine tool_use, uneltele necunoscute se sar", () => {
  const raw = '<spoken>Checking.</spoken><ro>Mă uit.</ro>\n<unelte>[{"name":"agenda_citeste","input":{"zile":1}},{"name":"sterge_tot","input":{}}]</unelte>';
  const reply = parseReply(raw, TOOLS, id);
  assert.equal(reply.stop_reason, "tool_use");
  assert.equal(reply.content.length, 2);
  assert.equal(reply.content[0].text, "<spoken>Checking.</spoken><ro>Mă uit.</ro>");
  assert.equal(reply.content[1].type, "tool_use");
  assert.equal(reply.content[1].name, "agenda_citeste");
  assert.deepEqual(reply.content[1].input, { zile: 1 });
});

test("bloc stricat: nu se inventează unelte, rămâne textul", () => {
  const reply = parseReply("<spoken>Ok</spoken><unelte>[{name: agenda", TOOLS, id);
  assert.equal(reply.stop_reason, "end_turn");
  assert.equal(reply.content.length, 1);
});

test("textul de spus nu include blocul de unelte, nici un început de bloc rămas la coadă", () => {
  assert.equal(visiblePart("<spoken>Ok</spoken><unelte>[{"), "<spoken>Ok</spoken>");
  assert.equal(visiblePart("<spoken>Ok</spoken><un"), "<spoken>Ok</spoken>");
  assert.equal(visiblePart("<spoken>Ok</spoken>"), "<spoken>Ok</spoken>");
});

test("conversația: replici, unelte chemate, rezultatele lor și pozele separat", () => {
  const blocks = renderTurn(
    [
      { role: "user", content: "Ce am mâine?" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Mă uit." }, { type: "tool_use", id: "t1", name: "agenda_citeste", input: { zile: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "10:00 Ședință" }] },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } }, { type: "text", text: "Și asta?" }] },
    ],
    "MEMORIE: Jess e Jessica",
  );
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  assert.match(text, /Daniel: Ce am mâine\?/);
  assert.match(text, /<unelte>\[\{"name":"agenda_citeste","input":\{"zile":1\}\}\]<\/unelte>/);
  assert.match(text, /\[agenda_citeste\] 10:00 Ședință/);
  assert.match(text, /MEMORIE: Jess e Jessica/);
  assert.match(text, /Și asta\?/);
  assert.doesNotMatch(text, /thinking/);
  assert.equal(blocks.filter((b) => b.type === "image").length, 1);
});

test("rândurile SSE de la Upstash", () => {
  assert.deepEqual(parseSse('data: message,argus:creier:r:1,{"t":"x","n":0,"d":"a,b"}'), { kind: "message", payload: '{"t":"x","n":0,"d":"a,b"}' });
  assert.deepEqual(parseSse("data: subscribe,argus:creier:r:1,1"), { kind: "subscribe", payload: "1" });
  assert.equal(parseSse(": ping"), null);
});
