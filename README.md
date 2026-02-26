# Job Hunt Portal (Phase 2)

Express + SQLite implementation of a two-agent pipeline:

1. **Agent A** — Extract job ad into structured JSON and store in SQLite
2. **Agent B** — Generate tailored cover letter using extracted JSON + sample cover letter

## Features

- Job ad textbox
- Sample cover letter textbox
- Resume upload field (`.doc`/`.docx`, currently selection only)
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

## API endpoints

- `POST /api/extract-job`
  - body: `{ "jobAd": "..." }`
- `POST /api/generate-letter`
  - body: `{ "extractionId": 1, "sampleCoverLetter": "...", "yourName": "Your Name" }`
- `GET /api/extractions`

## Deployment note

This Phase 2 version needs a Node server + SQLite, so it **cannot run on GitHub Pages alone**.
Use a backend host (Render/Railway/Fly.io/etc.) for production.
