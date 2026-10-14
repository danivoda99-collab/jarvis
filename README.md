# JARVIS

Asistentul personal vocal al lui Daniel: o aplicație web care se instalează pe iPhone și laptop și vorbește cu agentul JARVIS din ElevenLabs.

## Cum funcționează

- `app/page.tsx` arată ecranul de cod sau ecranul JARVIS.
- `app/jarvis.tsx` e ecranul principal: orbul pornește și oprește conversația vocală.
- `app/api/login` verifică codul de acces și pune o sesiune valabilă un an.
- `app/api/session` cere la ElevenLabs un token de conversație. Cheia API stă doar pe server.

## Variabile în Vercel

Vezi `.env.example`: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `JARVIS_PASSCODE`, `SESSION_SECRET`.

## Local

```
npm install
cp .env.example .env.local   # completează valorile
npm run dev
```
