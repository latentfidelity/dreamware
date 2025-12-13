# dreamware — Coding Agent Notes

## What this is
Node/Express + WebSocket “Dreamware” app generator. Serves a static UI and streams Claude output; also includes a serverless-style endpoint in `api/generate.js`.

## Setup / run (local)
- `npm install`
- `cp .env.example .env` and set `ANTHROPIC_API_KEY`
- `npm run dev` (watch) or `npm start`

## Protocol constraints
- WebSocket messages: `{ "type": "generate", "prompt": "..." }` and `{ "type": "cancel" }`.
- The output parser depends on a fenced ` ```html ... ``` ` code block containing a complete single-file app; don’t change this without updating both generator + client parsing.

## Conventions
- Keep ESM (`"type": "module"`); avoid `require`.
- Never commit `.env` or secrets; don’t log sensitive config.
- Don’t edit generated/vendor folders like `node_modules/` or `.vercel/`.

