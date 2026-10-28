import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

mkdirSync(resolve(root, 'dist', 'assets'), { recursive: true })
mkdirSync(resolve(root, 'dist', 'web'), { recursive: true })

const thumbSrc = resolve(root, 'assets', 'allybot-menu-thumbnail.jpg')
const thumbDst = resolve(root, 'dist', 'assets', 'allybot-menu-thumbnail.jpg')
if (existsSync(thumbSrc)) {
  copyFileSync(thumbSrc, thumbDst)
}

const htmlSrc = resolve(root, 'src', 'web', 'index.html')
const htmlDst = resolve(root, 'dist', 'web', 'index.html')
if (existsSync(htmlSrc)) {
  copyFileSync(htmlSrc, htmlDst)
}
