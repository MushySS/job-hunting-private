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

function isLikelyHeading(text, styleId = '') {
  const t = (text || '').trim()
  if (!t) return false

  if (/heading|title|subtitle/i.test(styleId)) return true

  const letters = (t.match(/[A-Za-z]/g) || []).length
  const isShort = t.length <= 70
  const mostlyUpper = letters > 0 && t.replace(/[^A-Za-z]/g, '').toUpperCase() === t.replace(/[^A-Za-z]/g, '')
  const simple = !/[.:;!?]/.test(t)

  return isShort && mostlyUpper && simple
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
  const heading = isLikelyHeading(text, styleId)

  structure.push({ index: i, text, styleId, hasList, isHeading: heading })
  if (heading) headingsInOrder.push(text)
}

// Save structure JSON first (as requested)
fs.mkdirSync(outputDir, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const structurePath = path.join(outputDir, `resume-structure-${ts}.json`)
fs.writeFileSync(structurePath, JSON.stringify({ headingsInOrder, structure }, null, 2))

// Use structure + headings to preserve layout and only replace non-heading content.
let currentHeadingKey = '__root__'
let rootIdx = 0
const sectionIdx = {}
let replaced = 0

for (let i = 0; i < paragraphs.length; i++) {
  const p = paragraphs[i]
  const meta = structure[i]
  const textNodes = select('.//w:t', p)
  if (!textNodes.length) continue

  if (meta.isHeading) {
    currentHeadingKey = normalizeHeading(meta.text)
    continue // preserve heading text exactly
  }

  const section = mdSections[currentHeadingKey] || []
  if (!(currentHeadingKey in sectionIdx)) sectionIdx[currentHeadingKey] = 0
  let next = section[sectionIdx[currentHeadingKey]]

  if (!next) {
    // fallback to root content if section is exhausted/unmatched
    const root = mdSections.__root__ || []
    next = root[rootIdx++]
  }

  if (!next) continue

  textNodes[0].textContent = next
  for (let t = 1; t < textNodes.length; t++) textNodes[t].textContent = ''

  if (mdSections[currentHeadingKey]?.length) sectionIdx[currentHeadingKey] += 1
  replaced += 1
}

const serializer = new XMLSerializer()
const updatedXml = serializer.serializeToString(doc)
zip.file(docXmlPath, updatedXml)

const outDocx = path.join(outputDir, `optimized-resume-${ts}.docx`)
await fs.promises.writeFile(outDocx, await zip.generateAsync({ type: 'nodebuffer' }))

console.log('Source docx:', sourceDocx)
console.log('Optimized markdown:', optimizedMd)
console.log('Structure JSON:', structurePath)
console.log('Exported docx:', outDocx)
console.log(`Paragraphs replaced (content only): ${replaced}`)
