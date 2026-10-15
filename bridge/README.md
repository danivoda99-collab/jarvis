# Puntea Argus → laptop

Programul mic care stă pe laptopul lui Argus, preia cererile trimise din aplicație („zi-i lui Claude să…”) și le dă lui Claude Code. Rezultatul apare în aplicație ca fereastră; un mail pleacă doar după ce Daniel apasă Da pe telefon.

Ce poate Claude prin punte: citește și caută (web, Gmail, Drive, Calendar), scrie fișiere în `proiecte`, face ciorne de mail. Nu rulează comenzi și nu trimite nimic fără „Da”.

## Instalare (o singură dată)

1. În Vercel → proiectul jarvis → Storage → Create Database → Upstash for Redis (Free) → Connect la proiect. Apoi Redeploy.
2. Pe laptop: copiază folderul `bridge` în `C:\Users\Argus\argus\bridge`.
3. Într-un terminal acolo: `node argus-bridge.mjs`. Prima dată cere codul aplicației Argus; după „Puntea Argus pornită” o poți opri cu Ctrl+C.
4. Pornire automată: Win+R → `shell:startup` → pune acolo o scurtătură către `porneste-ascuns.vbs`.

Numele uneltelor Gmail/Drive din `argus-bridge.mjs` trebuie să fie cele din `claude mcp list` pe laptop; dacă diferă, se schimbă acolo.
