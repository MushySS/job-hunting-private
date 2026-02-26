import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import mammoth from 'mammoth'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const app = express()
const port = process.env.PORT || 3000

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const LLM_MODE = (process.env.LLM_MODE || 'false').toLowerCase() === 'true'

const dataDir = path.resolve('data')
const dbPath = path.resolve('data/job-hunt.db')
fs.mkdirSync(dataDir, { recursive: true })

const uploadsDir = path.resolve('data/uploads')
const outputDir = path.resolve('output')
fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(outputDir, { recursive: true })

const upload = multer({ dest: uploadsDir })
const execFileAsync = promisify(execFile)

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
app.use('/output', express.static(outputDir))

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

function fallbackExtraction(jobAd) {
  return {
    role_title: extractRole(jobAd),
    company: extractCompany(jobAd),
    location: (jobAd.match(/Location\s+([A-Za-z ,]+)/i)?.[1] || '').trim(),
    employment_type: (jobAd.match(/Job type\s+([A-Za-z ,&/-]+)/i)?.[1] || '').trim(),
    seniority: /level\s*1\s*&\s*2|level\s*2/i.test(jobAd) ? 'Level 1/2 support' : '',
    must_have_skills: extractListByKeywords(jobAd, [
      'Active Directory', 'Office 365', 'TCP/IP', 'LAN', 'WAN', 'Windows',
      'customer service', 'ticket', 'troubleshoot', 'KPI',
    ]),
    nice_to_have_skills: extractListByKeywords(jobAd, ['CompTIA A+', 'Microsoft certification', 'ITIL', 'AZ-900', 'AZ-104']),
    tools_tech_mentioned: extractListByKeywords(jobAd, [
      'Windows Server 2012 R2', 'Active Directory', 'Windows 7', 'Windows 10',
      'Office 365', 'TCP/IP', 'LAN', 'WAN', 'Apple', 'Android', 'Wiki',
    ]),
    responsibilities: [
      'Respond to service desk/help desk requests',
      'Troubleshoot hardware/software/network issues',
      'Log and close tickets with resolution notes',
      'Maintain user communication and KPI alignment',
    ],
    keywords_for_ats: extractListByKeywords(jobAd, [
      'Help Desk', 'Service Desk', 'Level 1', 'Level 2', 'Active Directory',
      'Office 365', 'TCP/IP', 'customer service', 'KPI', 'troubleshooting',
    ]),
    selection_criteria: [
      /2\+?\s*years.*Australia/i.test(jobAd) ? "2+ years' work experience in Australia" : '',
      /excellent communication/i.test(jobAd) ? 'Excellent communication skills' : '',
      /ownership|take Ownership/i.test(jobAd) ? 'Ownership and follow-through' : '',
    ].filter(Boolean),
    notes: 'Auto-extracted via fallback heuristic parser. Review before applying.',
  }
}

async function callOpenAI(messages, temperature = 0.2) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature }),
  })

  if (!resp.ok) {
    const txt = await resp.text()
    throw new Error(`OpenAI error ${resp.status}: ${txt.slice(0, 300)}`)
  }

  const data = await resp.json()
  return data?.choices?.[0]?.message?.content || ''
}

function extractJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON object found in LLM output')
  return JSON.parse(match[0])
}

async function llmExtraction(jobAd) {
  const schemaPrompt = `Return ONLY valid JSON with this exact schema keys:\n{
  "role_title": "",
  "company": "",
  "location": "",
  "employment_type": "",
  "seniority": "",
  "must_have_skills": [],
  "nice_to_have_skills": [],
  "tools_tech_mentioned": [],
  "responsibilities": [],
  "keywords_for_ats": [],
  "selection_criteria": [],
  "notes": ""
}\nRules: no markdown; do not invent facts; use empty string/array if unknown.`

  const content = await callOpenAI([
    { role: 'system', content: 'You are Agent A for L1 Helpdesk/Service Desk job extraction.' },
    { role: 'user', content: `${schemaPrompt}\n\nJob Ad:\n${jobAd}` },
  ])

  return extractJsonFromText(content)
}

async function llmCoverLetter({ extraction, sampleCoverLetter, yourName, personalInfo, resumeParsed }) {
  const prompt = `You are Agent B for cover letter tailoring.
Create a concise professional cover letter for L1 Helpdesk/Service Desk style roles.
Keep claims truthful and align to ATS keywords.
Replace placeholders with real values.

Extraction JSON:\n${JSON.stringify(extraction, null, 2)}

Base letter:\n${sampleCoverLetter}

Candidate name: ${yourName}

Personal information to incorporate (if provided):
${personalInfo || 'N/A'}

Parsed resume data to incorporate (if provided):
${resumeParsed ? JSON.stringify(resumeParsed, null, 2) : 'N/A'}

Return only the final cover letter text.`

  return callOpenAI([
    { role: 'system', content: 'You are a precise job application writer.' },
    { role: 'user', content: prompt },
  ], 0.35)
}

function useLLM() {
  return LLM_MODE && Boolean(OPENAI_API_KEY)
}

function latestOptimizedDocx() {
  const files = fs.readdirSync(outputDir)
    .filter((f) => /^optimized-resume-.*\.docx$/.test(f))
    .map((f) => ({
      name: f,
      full: path.join(outputDir, f),
      mtime: fs.statSync(path.join(outputDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
  return files[0] || null
}

function parseResumeSections(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const text = lines.join('\n')

  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || ''
  const phone = text.match(/(\+?\d[\d\s()-]{7,}\d)/)?.[0] || ''
  const name = lines[0] || ''

  const lower = lines.map((l) => l.toLowerCase())
  const skills = lines.filter((l, i) => /skills|technical skills|core skills/.test(lower[i]))

  const certifications = lines.filter((l) => /(certification|certified|az-900|az-104|comptia|itil)/i.test(l))

  return {
    name,
    email,
    phone,
    highlights: lines.slice(0, 12),
    skills_detected: skills,
    certifications,
    raw_excerpt: rawText.slice(0, 4000),
  }
}

// Phase 3: Resume parser (.docx recommended)
app.post('/api/parse-resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'resume file is required (field name: resume)' })

    const originalName = req.file.originalname || ''
    const ext = path.extname(originalName).toLowerCase()

    if (ext === '.doc') {
      return res.status(400).json({
        error: 'Legacy .doc parsing is not supported reliably. Please save as .docx and upload again.',
      })
    }

    const { value } = await mammoth.extractRawText({ path: req.file.path })
    const parsed = parseResumeSections(value || '')

    return res.json({
      ok: true,
      filename: originalName,
      parsed,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Phase 3b: summarize parsed resume into personal-info snippets
app.post('/api/summarize-personal-info', async (req, res) => {
  try {
    const { parsedResume } = req.body || {}
    if (!parsedResume || typeof parsedResume !== 'object') {
      return res.status(400).json({ error: 'parsedResume object is required' })
    }

    if (useLLM()) {
      const prompt = `Summarize this parsed resume into short personal-info snippets for cover-letter tailoring.
Return ONLY JSON in this format:
{
  "snippets": ["...", "..."],
  "summary": "..."
}
Rules:
- 5 to 10 snippets
- each snippet short and factual
- no invented claims

Parsed resume JSON:
${JSON.stringify(parsedResume, null, 2)}`

      const content = await callOpenAI([
        { role: 'system', content: 'You create concise, factual candidate profile snippets for job applications.' },
        { role: 'user', content: prompt },
      ], 0.2)

      const parsed = extractJsonFromText(content)
      const snippets = Array.isArray(parsed.snippets) ? parsed.snippets : []
      const summary = parsed.summary || snippets.join(' | ')
      return res.json({ mode: 'llm', snippets, summary })
    }

    const snippets = [
      parsedResume.name ? `Candidate: ${parsedResume.name}` : '',
      parsedResume.email ? `Email: ${parsedResume.email}` : '',
      parsedResume.phone ? `Phone: ${parsedResume.phone}` : '',
      ...(parsedResume.certifications || []).slice(0, 4).map((c) => `Certification: ${c}`),
      ...(parsedResume.highlights || []).slice(0, 4),
    ].filter(Boolean)

    return res.json({ mode: 'fallback', snippets, summary: snippets.join(' | ') })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Agent A: Extractor
app.post('/api/extract-job', async (req, res) => {
  try {
    const { jobAd } = req.body || {}
    if (!jobAd || typeof jobAd !== 'string') {
      return res.status(400).json({ error: 'jobAd is required' })
    }

    const extraction = useLLM() ? await llmExtraction(jobAd) : fallbackExtraction(jobAd)

    const stmt = db.prepare(`
      INSERT INTO job_extractions (
        company, role_title, location, employment_type, seniority,
        must_have_skills, nice_to_have_skills, tools_tech_mentioned,
        responsibilities, keywords_for_ats, selection_criteria, notes, source_job_ad
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const info = stmt.run(
      extraction.company || '',
      extraction.role_title || '',
      extraction.location || '',
      extraction.employment_type || '',
      extraction.seniority || '',
      JSON.stringify(extraction.must_have_skills || []),
      JSON.stringify(extraction.nice_to_have_skills || []),
      JSON.stringify(extraction.tools_tech_mentioned || []),
      JSON.stringify(extraction.responsibilities || []),
      JSON.stringify(extraction.keywords_for_ats || []),
      JSON.stringify(extraction.selection_criteria || []),
      extraction.notes || '',
      jobAd,
    )

    return res.json({ extractionId: Number(info.lastInsertRowid), extraction, mode: useLLM() ? 'llm' : 'fallback' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Agent B: Cover-letter generator
app.post('/api/generate-letter', async (req, res) => {
  try {
    const { extractionId, sampleCoverLetter, yourName = '[MY NAME]', personalInfo = '', resumeParsed = null } = req.body || {}

    if (!extractionId || !sampleCoverLetter) {
      return res.status(400).json({ error: 'extractionId and sampleCoverLetter are required' })
    }

    const row = db.prepare('SELECT * FROM job_extractions WHERE id = ?').get(extractionId)
    if (!row) return res.status(404).json({ error: 'Extraction not found' })

    const extraction = {
      company: row.company,
      role_title: row.role_title,
      location: row.location,
      employment_type: row.employment_type,
      seniority: row.seniority,
      must_have_skills: JSON.parse(row.must_have_skills || '[]'),
      nice_to_have_skills: JSON.parse(row.nice_to_have_skills || '[]'),
      tools_tech_mentioned: JSON.parse(row.tools_tech_mentioned || '[]'),
      responsibilities: JSON.parse(row.responsibilities || '[]'),
      keywords_for_ats: JSON.parse(row.keywords_for_ats || '[]'),
      selection_criteria: JSON.parse(row.selection_criteria || '[]'),
      notes: row.notes,
    }

    let letter
    if (useLLM()) {
      letter = await llmCoverLetter({ extraction, sampleCoverLetter, yourName, personalInfo, resumeParsed })
    } else {
      const company = extraction.company || '[COMPANY NAME]'
      const role = extraction.role_title || 'Level 1 IT Support Technician'
      const keywords = extraction.keywords_for_ats || []

      letter = sampleCoverLetter
        .replaceAll('[COMPANY NAME]', company)
        .replaceAll('[MY NAME]', yourName)
        .replace(/Level 1 IT Support Technician/gi, role)

      const personalLine = personalInfo
        ? `\n\nAdditional candidate context: ${personalInfo}`
        : ''
      const resumeLine = resumeParsed
        ? `\n\nResume highlights to align with this role: ${JSON.stringify(resumeParsed).slice(0, 700)}`
        : ''
      const atsLine = keywords.length
        ? `\n\nI am well prepared to contribute in areas such as ${keywords.slice(0, 8).join(', ')}, while maintaining strong customer service and structured service desk practices.`
        : ''
      letter += personalLine + resumeLine + atsLine
    }

    const save = db.prepare(`
      INSERT INTO cover_letters (extraction_id, company, role_title, letter_text)
      VALUES (?, ?, ?, ?)
    `)
    const saveInfo = save.run(extractionId, extraction.company || '', extraction.role_title || '', letter)

    return res.json({
      letterId: Number(saveInfo.lastInsertRowid),
      company: extraction.company,
      role_title: extraction.role_title,
      coverLetter: letter,
      mode: useLLM() ? 'llm' : 'fallback',
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

app.get('/api/extractions', (_req, res) => {
  const rows = db
    .prepare('SELECT id, company, role_title, location, employment_type, created_at FROM job_extractions ORDER BY id DESC LIMIT 50')
    .all()
  res.json(rows)
})

app.post('/api/generate-optimized-docx', async (req, res) => {
  try {
    const { specialInstructions = '' } = req.body || {}

    await execFileAsync(process.execPath, ['scripts/optimize-resume.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, SPECIAL_INSTRUCTIONS: specialInstructions },
      maxBuffer: 1024 * 1024 * 5,
    })

    await execFileAsync(process.execPath, ['scripts/export-optimized-docx.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 5,
    })

    const latest = latestOptimizedDocx()
    if (!latest) throw new Error('DOCX export did not produce an output file')

    return res.json({
      ok: true,
      file: latest.name,
      downloadUrl: `/output/${latest.name}`,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, llmMode: useLLM(), model: OPENAI_MODEL })
})

async function ddgLiteSearch(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const resp = await fetch(url)
  if (!resp.ok) return []
  const html = await resp.text()

  const results = []
  const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g
  let m
  while ((m = regex.exec(html)) !== null && results.length < 5) {
    const href = m[1]
    const title = m[2].replace(/<[^>]+>/g, '').trim()
    results.push({ title, url: href })
  }
  return results
}

app.post('/api/advanced-optimize', async (req, res) => {
  try {
    const { jobAd = '', personalInfo = '', parsedResume = null, specialInstructions = '' } = req.body || {}
    if (!jobAd) return res.status(400).json({ error: 'jobAd is required' })

    const webResults = await ddgLiteSearch(`helpdesk resume improvements ${jobAd.slice(0, 120)}`)

    const basePayload = {
      jobAd,
      personalInfo,
      parsedResume,
      webResults,
      specialInstructions,
    }

    if (!useLLM()) {
      return res.json({
        mode: 'fallback',
        suggestions: [
          'Align your summary with L1/L2 Helpdesk keywords from the job ad.',
          'Add quantifiable troubleshooting outcomes in experience bullets.',
          'Prioritize Active Directory, Microsoft 365, ticketing, and customer service evidence.',
        ],
        matchedSkills: (parsedResume?.skills_detected || []).slice(0, 8),
        gaps: ['Tailored metrics', 'Role-specific keyword alignment'],
        webResults,
      })
    }

    const prompt = `You are an advanced resume optimizer for IT Helpdesk roles.
Given input JSON, produce ONLY valid JSON:
{
  "matchedSkills": ["..."],
  "gaps": ["..."],
  "suggestions": ["..."],
  "improvedPersonalInfoSnippets": ["..."]
}
Rules:
- Be factual and practical.
- Keep suggestions concise and actionable.
- Prefer ATS-friendly phrasing.

Input JSON:
${JSON.stringify(basePayload, null, 2)}`

    const content = await callOpenAI([
      { role: 'system', content: 'You optimize resumes and personal profiles for ATS and Helpdesk hiring managers.' },
      { role: 'user', content: prompt },
    ], 0.25)

    const parsed = extractJsonFromText(content)
    return res.json({ mode: 'llm', ...parsed, webResults })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

app.listen(port, () => {
  console.log(`Job Hunt Portal API running on http://localhost:${port}`)
  console.log(`Mode: ${useLLM() ? `LLM (${OPENAI_MODEL})` : 'fallback parser'} | Set LLM_MODE=true + OPENAI_API_KEY to enable`) 
})
