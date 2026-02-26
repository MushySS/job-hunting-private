import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import xpath from 'xpath'

const uploadsDir = path.resolve('data/uploads')
const outputDir = path.resolve('output')

function latestFile(dir, matcher = () => true) {
  const files = fs.readdirSync(dir)
    .filter((f) => matcher(f))
    .map((f) => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.full
}

function cleanMdLine(line) {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function normalizeHeading(s = '') {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function parseMdSections(md) {
  const sections = {}
  let current = '__root__'
  sections[current] = []

  const lines = md.split(/\r?\n/).map((l) => l.trim())
  for (const raw of lines) {
    if (!raw || /^```/.test(raw)) continue

    if (/^#{1,6}\s+/.test(raw)) {
      const h = cleanMdLine(raw)
      current = normalizeHeading(h) || '__root__'
      if (!sections[current]) sections[current] = []
      continue
    }

    const cleaned = cleanMdLine(raw)
    if (!cleaned) continue
    if (!sections[current]) sections[current] = []
    sections[current].push(cleaned)
  }

  return sections
}

const STRICT_MODE = (process.env.STRICT_MODE || 'true').toLowerCase() === 'true'
const PROTECTED_HEADINGS = (process.env.PROTECTED_HEADINGS || '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean)

function heuristicHeading(text, hasList = false) {
  const t = (text || '').trim()
  if (!t || hasList) return false
  const lettersOnly = t.replace(/[^A-Za-z]/g, '')
  const words = t.split(/\s+/).filter(Boolean)
  const allCaps = lettersOnly.length > 0 && lettersOnly === lettersOnly.toUpperCase()
  const shortLine = t.length <= 45 && words.length <= 6
  const noSentencePunct = !/[.:;!?]/.test(t)
  return allCaps && shortLine && noSentencePunct
}

function isLikelyHeading(text, styleId = '', hasList = false) {
  const t = (text || '').trim()
  if (!t) return false
  if (hasList) return false

  // Strict mode: trust explicit DOCX heading/title styles only.
  if (STRICT_MODE) return /heading|title|subtitle/i.test(styleId)

  if (/heading|title|subtitle/i.test(styleId)) return true
  return heuristicHeading(t, hasList)
}

const sourceDocx = latestFile(uploadsDir)
if (!sourceDocx) {
  console.error('No source resume found in data/uploads')
  process.exit(1)
}

const optimizedMd = latestFile(outputDir, (f) => f.startsWith('optimized-resume-') && f.endsWith('.md'))
if (!optimizedMd) {
  console.error('No optimized resume markdown found in output/')
  process.exit(1)
}

const optimizedText = fs.readFileSync(optimizedMd, 'utf8')
const mdSections = parseMdSections(optimizedText)

const zipBuffer = fs.readFileSync(sourceDocx)
const zip = await JSZip.loadAsync(zipBuffer)
const docXmlPath = 'word/document.xml'
const xmlString = await zip.file(docXmlPath)?.async('string')

if (!xmlString) {
  console.error('Could not read word/document.xml from source docx')
  process.exit(1)
}

const doc = new DOMParser().parseFromString(xmlString, 'text/xml')
const select = xpath.useNamespaces({ w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main' })
const paragraphs = select('//w:body/w:p', doc)

const structure = []
const headingsInOrder = []

for (let i = 0; i < paragraphs.length; i++) {
  const p = paragraphs[i]
  const textNodes = select('.//w:t', p)
  const text = textNodes.map((n) => n.textContent || '').join('').trim()
  const styleAttr = select('./w:pPr/w:pStyle/@w:val', p)?.[0]
  const styleId = styleAttr?.value || ''
  const hasList = select('./w:pPr/w:numPr', p).length > 0
  const heading = isLikelyHeading(text, styleId, hasList)

  structure.push({ index: i, text, styleId, hasList, isHeading: heading })
  if (heading) headingsInOrder.push(text)
}

// If strict style-based detection finds too few headings, auto-fallback to conservative heuristic.
let usedHeadingMode = STRICT_MODE ? 'strict-style' : 'heuristic'
if (STRICT_MODE && headingsInOrder.length < 2) {
  usedHeadingMode = 'strict-fallback-heuristic'
  headingsInOrder.length = 0
  for (const item of structure) {
    item.isHeading = heuristicHeading(item.text, item.hasList)
    if (item.isHeading) headingsInOrder.push(item.text)
  }
}

// Save structure JSON (as requested)
fs.mkdirSync(outputDir, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const structurePath = path.join(outputDir, `resume-structure-${ts}.json`)

// Build section blocks from original DOCX and replace content *within each section only*.
// This avoids heading/content style drift caused by cross-section fallback.
const blocks = []
let current = { key: '__root__', headingText: '', contentParagraphIndexes: [] }

for (let i = 0; i < structure.length; i++) {
  const meta = structure[i]
  if (meta.isHeading) {
    blocks.push(current)
    current = {
      key: normalizeHeading(meta.text) || '__root__',
      headingText: meta.text,
      contentParagraphIndexes: [],
    }
    continue
  }

  const p = paragraphs[i]
  const textNodes = select('.//w:t', p)
  if (!textNodes.length) continue

  // Replace only non-empty body paragraphs. Keep blanks/layout spacers untouched.
  if ((meta.text || '').trim()) current.contentParagraphIndexes.push(i)
}
blocks.push(current)

let replaced = 0
const missingSections = []

fs.writeFileSync(
  structurePath,
  JSON.stringify(
    {
      headingsInOrder,
      structure,
      blocks: blocks.map((b) => ({
        key: b.key,
        headingText: b.headingText,
        contentSlots: b.contentParagraphIndexes.length,
      })),
    },
    null,
    2,
  ),
)

const sectionReport = []

for (const block of blocks) {
  const headingNorm = normalizeHeading(block.headingText)
  const isProtected = PROTECTED_HEADINGS.includes(headingNorm)
  const candidateLines = mdSections[block.key] || []
  if (!mdSections[block.key] && block.key !== '__root__') missingSections.push(block.headingText || block.key)

  if (isProtected) {
    sectionReport.push({
      heading: block.headingText,
      key: block.key,
      protected: true,
      slots: block.contentParagraphIndexes.length,
      sourceLines: candidateLines.length,
      replaced: 0,
      overflowDropped: candidateLines.length,
    })
    continue
  }

  const limit = Math.min(block.contentParagraphIndexes.length, candidateLines.length)

  for (let j = 0; j < limit; j++) {
    const pIndex = block.contentParagraphIndexes[j]
    const p = paragraphs[pIndex]
    const textNodes = select('.//w:t', p)
    const next = candidateLines[j]
    if (!textNodes.length || !next) continue

    textNodes[0].textContent = next
    for (let t = 1; t < textNodes.length; t++) textNodes[t].textContent = ''
    replaced += 1
  }

  sectionReport.push({
    heading: block.headingText,
    key: block.key,
    protected: false,
    slots: block.contentParagraphIndexes.length,
    sourceLines: candidateLines.length,
    replaced: limit,
    overflowDropped: Math.max(0, candidateLines.length - limit),
  })
}

const serializer = new XMLSerializer()
const updatedXml = serializer.serializeToString(doc)
zip.file(docXmlPath, updatedXml)

const outDocx = path.join(outputDir, `optimized-resume-${ts}.docx`)
await fs.promises.writeFile(outDocx, await zip.generateAsync({ type: 'nodebuffer' }))

const strictReportPath = path.join(outputDir, `resume-strict-report-${ts}.json`)
fs.writeFileSync(
  strictReportPath,
  JSON.stringify(
    {
      strictMode: STRICT_MODE,
      headingModeUsed: usedHeadingMode,
      protectedHeadings: PROTECTED_HEADINGS,
      replaced,
      missingSections: [...new Set(missingSections)],
      sections: sectionReport,
    },
    null,
    2,
  ),
)

console.log('Source docx:', sourceDocx)
console.log('Optimized markdown:', optimizedMd)
console.log('Structure JSON:', structurePath)
console.log('Strict report JSON:', strictReportPath)
console.log('Exported docx:', outDocx)
console.log(`Paragraphs replaced (content only): ${replaced}`)
if (missingSections.length) {
  console.log('Sections without heading match in markdown (left structurally intact):')
  console.log([...new Set(missingSections)].join(' | '))
}
