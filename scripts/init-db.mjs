import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dbPath = path.resolve('data/job-hunt.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const db = new DatabaseSync(dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS job_extractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT,
    role_title TEXT,
    location TEXT,
    employment_type TEXT,
    seniority TEXT,
    must_have_skills TEXT,
    nice_to_have_skills TEXT,
    tools_tech_mentioned TEXT,
    responsibilities TEXT,
    keywords_for_ats TEXT,
    selection_criteria TEXT,
    notes TEXT,
    source_job_ad TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cover_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    extraction_id INTEGER,
    company TEXT,
    role_title TEXT,
    letter_text TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(extraction_id) REFERENCES job_extractions(id)
  );
`)

console.log(`Initialized database at ${dbPath}`)
