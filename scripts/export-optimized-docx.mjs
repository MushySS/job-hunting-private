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

function mdToParagraphs(md) {
  return md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '• ')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
    )
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
const newParagraphs = mdToParagraphs(optimizedText)

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

let idx = 0
for (const p of paragraphs) {
  const textNodes = select('.//w:t', p)
  if (!textNodes.length) continue

  const next = newParagraphs[idx++]
  if (!next) break

  textNodes[0].textContent = next
  for (let i = 1; i < textNodes.length; i++) textNodes[i].textContent = ''
}

const serializer = new XMLSerializer()
const updatedXml = serializer.serializeToString(doc)
zip.file(docXmlPath, updatedXml)

fs.mkdirSync(outputDir, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const outDocx = path.join(outputDir, `optimized-resume-${ts}.docx`)
await fs.promises.writeFile(outDocx, await zip.generateAsync({ type: 'nodebuffer' }))

console.log('Source docx:', sourceDocx)
console.log('Optimized markdown:', optimizedMd)
console.log('Exported docx:', outDocx)
console.log(`Paragraphs replaced: ${Math.min(idx, newParagraphs.length)}`)
