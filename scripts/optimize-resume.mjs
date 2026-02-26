import fs from 'node:fs'
import path from 'node:path'
import mammoth from 'mammoth'
import { DatabaseSync } from 'node:sqlite'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const SPECIAL_INSTRUCTIONS = process.env.SPECIAL_INSTRUCTIONS || ''
const PERSONAL_INFO = process.env.PERSONAL_INFO || ''
const OPTIMIZER_SUGGESTIONS = process.env.OPTIMIZER_SUGGESTIONS || ''

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment')
  process.exit(1)
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
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${await resp.text()}`)
  const data = await resp.json()
  return data.choices?.[0]?.message?.content || ''
}

async function ddgLiteSearch(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const resp = await fetch(url)
  if (!resp.ok) return []
  const html = await resp.text()
  const out = []
  const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g
  let m
  while ((m = regex.exec(html)) && out.length < 6) {
    out.push({ title: m[2].replace(/<[^>]+>/g, '').trim(), url: m[1] })
  }
  return out
}

function detectSectionOrder(text) {
  const candidates = ['Summary', 'Profile', 'Skills', 'Technical Skills', 'Experience', 'Employment History', 'Projects', 'Education', 'Certifications', 'References']
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const found = []
  for (const line of lines) {
    const hit = candidates.find((c) => line.toLowerCase() === c.toLowerCase())
    if (hit && !found.includes(hit)) found.push(hit)
  }
  return found.length ? found : ['Summary', 'Technical Skills', 'Experience', 'Education', 'Certifications']
}

const uploadsDir = path.resolve('data/uploads')
const files = fs.readdirSync(uploadsDir).map((f) => ({
  name: f,
  full: path.join(uploadsDir, f),
  mtime: fs.statSync(path.join(uploadsDir, f)).mtimeMs,
}))

if (!files.length) {
  console.error('No uploaded resume files found in data/uploads')
  process.exit(1)
}

files.sort((a, b) => b.mtime - a.mtime)
const resumePath = files[0].full

const { value: resumeText } = await mammoth.extractRawText({ path: resumePath })

const db = new DatabaseSync(path.resolve('data/job-hunt.db'))
const latestJob = db.prepare('SELECT source_job_ad FROM job_extractions ORDER BY id DESC LIMIT 1').get()
if (!latestJob?.source_job_ad) {
  console.error('No job ad found in DB (job_extractions). Run extraction first.')
  process.exit(1)
}

const sectionOrder = detectSectionOrder(resumeText)
const webResults = await ddgLiteSearch('IT helpdesk resume best practices ATS Australia')

const prompt = `You are an expert resume writer for L1/L2 Helpdesk roles.
Task: rewrite and optimize the candidate resume for the provided job ad.
Do not fabricate experience. Improve wording, ATS alignment, and impact.

CRITICAL FORMAT RULES:
1) Use EXACT section headings from this array in this exact order:
${JSON.stringify(sectionOrder)}
2) Render each heading as a markdown H2 line like: ## HEADING
3) Put bullet/content lines only under the correct heading
4) Do NOT add or remove top-level headings
5) Output ONLY markdown resume content
6) Do NOT wrap output in code fences

JOB AD:
${latestJob.source_job_ad}

CURRENT RESUME TEXT:
${resumeText}

WEB REFERENCES:
${JSON.stringify(webResults, null, 2)}

PERSONAL INFO TO CONSIDER:
${PERSONAL_INFO || 'N/A'}

OPTIMIZER SUGGESTIONS:
${OPTIMIZER_SUGGESTIONS || 'N/A'}

SPECIAL INSTRUCTIONS (highest priority if provided):
${SPECIAL_INSTRUCTIONS || 'N/A'}
`

let optimized = await callOpenAI([
  { role: 'system', content: 'You optimize resumes for ATS and recruiter readability.' },
  { role: 'user', content: prompt },
], 0.25)

// Safety cleanup in case model still returns fenced markdown
optimized = optimized
  .replace(/^```[a-zA-Z]*\s*\n?/m, '')
  .replace(/\n?```\s*$/m, '')
  .trim()

const outDir = path.resolve('output')
fs.mkdirSync(outDir, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = path.join(outDir, `optimized-resume-${ts}.md`)
const metaPath = path.join(outDir, `optimized-resume-meta-${ts}.json`)

fs.writeFileSync(outPath, optimized)
fs.writeFileSync(metaPath, JSON.stringify({ resumePath, sectionOrder, webResults }, null, 2))

console.log('Saved optimized resume to:')
console.log(outPath)
console.log('Saved metadata to:')
console.log(metaPath)
