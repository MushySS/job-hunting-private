# Job Hunt Portal (Phase 2)

Express + SQLite implementation of a two-agent pipeline:

1. **Agent A** — Extract job ad into structured JSON and store in SQLite
2. **Agent B** — Generate tailored cover letter using extracted JSON + sample cover letter

## Features

- Job ad textbox
- Sample cover letter textbox
- Resume upload field (`.doc`/`.docx`, currently selection only)
- Personal information textbox with Save/Clear (persisted in browser localStorage)
- `Extract Job JSON` button (calls `/api/extract-job`)
- `Generate Tailored Letter` button (calls `/api/generate-letter`)
- Stores extractions and generated letters in `data/job-hunt.db`

## Run locally

```bash
npm install
npm run db:init
npm start
```

Open: `http://localhost:3000`

## Enable LLM mode (Agent A + Agent B with tokens)

Set environment variables before starting:

```bash
export LLM_MODE=true
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_MODEL="gpt-4o-mini"   # optional
npm start
```

Quick check:

```bash
curl http://localhost:3000/api/health
```

## API endpoints

- `POST /api/extract-job`
  - body: `{ "jobAd": "..." }`
- `POST /api/generate-letter`
  - body: `{ "extractionId": 1, "sampleCoverLetter": "...", "yourName": "Your Name" }`
- `GET /api/extractions`

## Deployment note

This Phase 2 version needs a Node server + SQLite, so it **cannot run on GitHub Pages alone**.
Use a backend host (Render/Railway/Fly.io/etc.) for production.
