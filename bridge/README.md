# Puntea Argus → laptop

Programul mic care stă pe laptopul lui Argus, preia cererile trimise din aplicație („zi-i lui Claude să…”) și le dă lui Claude Code. Rezultatul apare în aplicație ca fereastră; un mail pleacă doar după ce Daniel apasă Da pe telefon.

Ce poate Claude prin punte (varianta „liber, cu limite”): citește și caută (web, Gmail, Drive, Calendar), scrie fișiere și rulează comenzi în `proiecte`, face ciorne de mail. Nu trimite nimic fără „Da” și nu are voie la comenzi care șterg sau schimbă sistemul (lista `BLOCKED` din `argus-bridge.mjs`).

## Instalare (o singură dată)

1. În Vercel → proiectul jarvis → Storage → Create Database → Upstash for Redis (Free) → Connect la proiect. Apoi Redeploy.
2. Pe laptop: copiază folderul `bridge` în `C:\Users\Argus\argus\bridge`.
3. Într-un terminal acolo: `node argus-bridge.mjs`. Prima dată cere codul aplicației Argus; după „Puntea Argus pornită” o poți opri cu Ctrl+C.
4. Pornire automată: Win+R → `shell:startup` → pune acolo o scurtătură către `porneste-ascuns.vbs`.

Numele uneltelor Gmail/Drive din `argus-bridge.mjs` trebuie să fie cele din `claude mcp list` pe laptop; dacă diferă, se schimbă acolo.

## Raportări în aplicația Team Vodă

Argus trimite raportările prin intrarea „Argus” din scriptul aplicației (doPost), ca să ajungă peste tot, ca la un om care raportează. După ce intrarea e instalată în Apps Script, pui în `config.json`:

```json
"teamVoda": { "url": "<adresa /exec a aplicației>", "secret": "<aceeași valoare ca ARGUS_SECRET din Script Properties>" }
```

Verificare: `node team-voda.mjs ping` (din folderul punții) trebuie să răspundă cu `ok: true`. Cheia rămâne doar în config.json; nu o trimite pe chat.

Acțiuni: `ping` (câmpuri și funcții permise), `raport` (se adaugă la săptămână), `tel` (obiective) și `call` (funcțiile din `ARGUS_FN`). Fără „Da” merg doar `ping` și citirea `AR_myReports`; orice scriere pleacă doar cu lacătul scris de punte după „Da”, pentru exact datele confirmate.
