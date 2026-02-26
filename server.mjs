import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'

const app = express()
const port = process.env.PORT || 3000

const dataDir = path.resolve('data')
const dbPath = path.resolve('data/job-hunt.db')
fs.mkdirSync(dataDir, { recursive: true })

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

app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.resolve('public')))

function extractCompany(jobAd) {
  const m1 = jobAd.match(/(?:at|@)\s+([A-Z][A-Za-z0-9&\- ]{2,})/i)
  if (m1?.[1]) return m1[1].trim()
  const m2 = jobAd.match(/About\s+(this role|the role)?\s*:?\s*([A-Z][A-Za-z0-9&\- ]{2,})/i)
  if (m2?.[2]) return m2[2].trim()
  return ''
}

function extractRole(jobAd) {
  const m = jobAd.match(/(?:position|role|job ad for)[:\s]+([A-Za-z0-9 &\-/]{5,80})/i)
  if (m?.[1]) return m[1].trim()
  if (/helpdesk|service desk/i.test(jobAd)) return 'Helpdesk / Service Desk'
  return ''
}

function extractListByKeywords(text, candidates) {
  const lc = text.toLowerCase()
  return candidates.filter((c) => lc.includes(c.toLowerCase()))
}

// Agent A: Extractor
app.post('/api/extract-job', (req, res) => {
  const { jobAd } = req.body || {}
  if (!jobAd || typeof jobAd !== 'string') {
    return res.status(400).json({ error: 'jobAd is required' })
  }

  const extraction = {
    role_title: extractRole(jobAd),
    company: extractCompany(jobAd),
    location: (jobAd.match(/Location\s+([A-Za-z ,]+)/i)?.[1] || '').trim(),
    employment_type: (jobAd.match(/Job type\s+([A-Za-z ,&/-]+)/i)?.[1] || '').trim(),
    seniority: /level\s*1\s*&\s*2|level\s*2/i.test(jobAd) ? 'Level 1/2 support' : '',
    must_have_skills: extractListByKeywords(jobAd, [
      'Active Directory',
      'Office 365',
      'TCP/IP',
      'LAN',
      'WAN',
      'Windows',
      'customer service',
      'ticket',
      'troubleshoot',
      'KPI',
    ]),
    nice_to_have_skills: extractListByKeywords(jobAd, [
      'CompTIA A+',
      'Microsoft certification',
      'ITIL',
      'AZ-900',
      'AZ-104',
    ]),
    tools_tech_mentioned: extractListByKeywords(jobAd, [
      'Windows Server 2012 R2',
      'Active Directory',
      'Windows 7',
      'Windows 10',
      'Office 365',
      'TCP/IP',
      'LAN',
      'WAN',
      'Apple',
      'Android',
      'Wiki',
    ]),
    responsibilities: [
      'Respond to service desk/help desk requests',
      'Troubleshoot hardware/software/network issues',
      'Log and close tickets with resolution notes',
      'Maintain user communication and KPI alignment',
    ],
    keywords_for_ats: extractListByKeywords(jobAd, [
      'Help Desk',
      'Service Desk',
      'Level 1',
      'Level 2',
      'Active Directory',
      'Office 365',
      'TCP/IP',
      'customer service',
      'KPI',
      'troubleshooting',
    ]),
    selection_criteria: [
      /2\+?\s*years.*Australia/i.test(jobAd) ? "2+ years' work experience in Australia" : '',
      /excellent communication/i.test(jobAd) ? 'Excellent communication skills' : '',
      /ownership|take Ownership/i.test(jobAd) ? 'Ownership and follow-through' : '',
    ].filter(Boolean),
    notes: 'Auto-extracted via Agent A heuristic parser. Review before applying.',
  }

  const stmt = db.prepare(`
    INSERT INTO job_extractions (
      company, role_title, location, employment_type, seniority,
      must_have_skills, nice_to_have_skills, tools_tech_mentioned,
      responsibilities, keywords_for_ats, selection_criteria, notes, source_job_ad
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const info = stmt.run(
    extraction.company,
    extraction.role_title,
    extraction.location,
    extraction.employment_type,
    extraction.seniority,
    JSON.stringify(extraction.must_have_skills),
    JSON.stringify(extraction.nice_to_have_skills),
    JSON.stringify(extraction.tools_tech_mentioned),
    JSON.stringify(extraction.responsibilities),
    JSON.stringify(extraction.keywords_for_ats),
    JSON.stringify(extraction.selection_criteria),
    extraction.notes,
    jobAd,
  )

  return res.json({ extractionId: Number(info.lastInsertRowid), extraction })
})

// Agent B: Cover-letter generator
app.post('/api/generate-letter', (req, res) => {
  const { extractionId, sampleCoverLetter, yourName = '[MY NAME]' } = req.body || {}

  if (!extractionId || !sampleCoverLetter) {
    return res.status(400).json({ error: 'extractionId and sampleCoverLetter are required' })
  }

  const row = db
    .prepare('SELECT * FROM job_extractions WHERE id = ?')
    .get(extractionId)

  if (!row) return res.status(404).json({ error: 'Extraction not found' })

  const company = row.company || '[COMPANY NAME]'
  const role = row.role_title || 'Level 1 IT Support Technician'
  const keywords = JSON.parse(row.keywords_for_ats || '[]')

  let letter = sampleCoverLetter
    .replaceAll('[COMPANY NAME]', company)
    .replaceAll('[MY NAME]', yourName)
    .replace(/Level 1 IT Support Technician/gi, role)

  const atsLine = keywords.length
    ? `\n\nI am well prepared to contribute in areas such as ${keywords.slice(0, 8).join(', ')}, while maintaining strong customer service and structured service desk practices.`
    : ''

  letter += atsLine

  const save = db.prepare(`
    INSERT INTO cover_letters (extraction_id, company, role_title, letter_text)
    VALUES (?, ?, ?, ?)
  `)
  const saveInfo = save.run(extractionId, company, role, letter)

  return res.json({
    letterId: Number(saveInfo.lastInsertRowid),
    company,
    role_title: role,
    coverLetter: letter,
  })
})

app.get('/api/extractions', (_req, res) => {
  const rows = db
    .prepare('SELECT id, company, role_title, location, employment_type, created_at FROM job_extractions ORDER BY id DESC LIMIT 50')
    .all()
  res.json(rows)
})

app.listen(port, () => {
  console.log(`Job Hunt Portal API running on http://localhost:${port}`)
})
