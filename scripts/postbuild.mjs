import { mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

mkdirSync(resolve(root, 'dist', 'assets'), { recursive: true })
mkdirSync(resolve(root, 'dist', 'web'), { recursive: true })

const assetsSrc = resolve(root, 'assets')
const assetsDst = resolve(root, 'dist', 'assets')
if (existsSync(assetsSrc)) {
  cpSync(assetsSrc, assetsDst, { recursive: true })
}

const htmlSrc = resolve(root, 'src', 'web', 'index.html')
const htmlDst = resolve(root, 'dist', 'web', 'index.html')
if (existsSync(htmlSrc)) {
  copyFileSync(htmlSrc, htmlDst)
}
