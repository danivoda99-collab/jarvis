#!/bin/bash
# Simulare: puntea cu un Claude Code fals și un server Argus fals (cădere, blocare, limită, server căzut, trimiteri).
# Rulează pe Linux/Mac: bash bridge/sim/run.sh — afișează la final ce a primit serverul și jurnalul punții.
cd "$(dirname "$0")"
rm -rf b proj *.log; mkdir -p b proj
sed 's/const RUN_TIMEOUT_MS = 15 \* 60_000;/const RUN_TIMEOUT_MS = 8_000;/' ../argus-bridge.mjs > b/argus-bridge.mjs
echo "{\"url\":\"http://127.0.0.1:4999\",\"cookie\":\"x\",\"claude\":\"$PWD/fake-claude.mjs\",\"folder\":\"$PWD/proj\",\"pregatire\":false}" > b/config.json
export SIM_LOG=$PWD/claude.log SRV_LOG=$PWD/server.log
node fake-server.mjs & SRV=$!
sleep 0.5
node b/argus-bridge.mjs --worker & BR=$!
add() { curl -s -XPOST localhost:4999/sim/add -d "$1" >/dev/null; }
sleep 4   # lanele speciale se încălzesc
add '{"titlu":"ok simplu","cerere":"SIM_OK fă ceva"}'
sleep 6
add '{"titlu":"grafic","cerere":"SIM_VIZ raport echipă"}'
add '{"titlu":"vizual stricat","cerere":"SIM_BADVIZ"}'
add '{"titlu":"crash lane","cerere":"SIM_CRASH"}'
add '{"titlu":"lent","cerere":"SIM_SLOW"}'
sleep 10
add '{"titlu":"crash total","cerere":"SIM_CRASHALL"}'
add '{"titlu":"eroare API","cerere":"SIM_ERROR"}'
add '{"titlu":"agățat","cerere":"SIM_HANG"}'
sleep 12
add '{"titlu":"limită","cerere":"SIM_LIMIT"}'
add '{"titlu":"aglomerat o dată","cerere":"SIM_ONCE"}'
sleep 8
add '{"titlu":"lent cu server căzut","cerere":"SIM_SLOW"}'
sleep 1.5; curl -s "localhost:4999/sim/down?ms=6000" >/dev/null
sleep 10
add '{"titlu":"whatsapp citire","cerere":"rezumă-mi WhatsApp-ul SIM_GATE_READ"}'
add '{"titlu":"whatsapp pregătire","cerere":"trimite pe whatsapp lui Jess salut SIM_CONFIRM"}'
sleep 8
add '{"titlu":"trimitere 1","cerere":"x","status":"confirmată","confirmare":{"titlu":"Trimit lui Jess","text":"Salut","destinatar":"Jess"}}'
add '{"titlu":"trimitere 2","cerere":"x","status":"confirmată","confirmare":{"titlu":"Trimit lui Ana","text":"Hei","destinatar":"Ana"}}'
sleep 14
curl -s localhost:4999/sim/state | head -c 600; echo
kill $BR $SRV
echo "=== server"; cat server.log; echo "=== claude"; cat claude.log | cut -c1-200; echo "=== bridge"; cat b/argus.log
