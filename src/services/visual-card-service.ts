import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'
import opentype from '@shuding/opentype.js'

export interface IqcReplyPreview {
  readonly sender: string
  readonly text: string
}

export interface IqcOptions {
  readonly text: string
  readonly senderName?: string
  readonly time?: string
  readonly avatarBuffer?: Buffer
  readonly menuItems?: readonly string[]
  readonly stickerMode?: boolean
  readonly theme?: 'dark' | 'light'
  readonly battery?: number
  readonly carrier?: string
  readonly signalStrength?: number
  readonly isOutgoing?: boolean
  readonly reply?: IqcReplyPreview
}

export interface QcOptions {
  readonly text: string
  readonly senderName: string
  readonly time?: string
  readonly avatarBuffer?: Buffer
  readonly isOutgoing?: boolean
}

export interface TweetOptions {
  readonly name: string
  readonly handle: string
  readonly text: string
  readonly time?: string
  readonly avatarBuffer?: Buffer
  readonly verified?: boolean
  readonly replies?: string
  readonly retweets?: string
  readonly likes?: string
  readonly views?: string
}

export interface ProfileCardOptions {
  readonly platform: 'tiktok' | 'instagram'
  readonly username: string
  readonly nickname: string
  readonly bio?: string
  readonly avatarBuffer?: Buffer
  readonly verified?: boolean
  readonly stats: {
    readonly followers: string
    readonly following: string
    readonly thirdStat: string
    readonly thirdStatLabel: string
  }
}

// Bounded in-memory emoji cache (max 500 entries)
const MAX_EMOJI_CACHE_ENTRIES = 500
const emojiAssetCache = new Map<string, string>()
const APPLE_EMOJI_BASE_URL = process.env.APPLE_EMOJI_BASE_URL ?? 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64'
const TWEMOJI_BASE_URL = process.env.TWEMOJI_BASE_URL ?? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg'

function cacheEmoji(key: string, val: string): void {
  if (emojiAssetCache.size >= MAX_EMOJI_CACHE_ENTRIES) {
    const first = emojiAssetCache.keys().next().value
    if (first) emojiAssetCache.delete(first)
  }
  emojiAssetCache.set(key, val)
}

// Pre-loaded font cache (loaded once at module init)
let cachedFonts: { name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[] | null = null

function loadFonts(): { name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[] {
  if (cachedFonts) return cachedFonts

  const primaryRegular = join(process.cwd(), 'assets', 'fonts', 'Inter.ttf')
  const primaryBold = join(process.cwd(), 'assets', 'fonts', 'Inter-Bold.ttf')
  const fallbackRegular = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  const fallbackBold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

  let reg: Buffer
  if (existsSync(primaryRegular)) {
    reg = readFileSync(primaryRegular)
  } else if (existsSync(fallbackRegular)) {
    reg = readFileSync(fallbackRegular)
  } else {
    throw new Error('No compatible TTF font found in assets/fonts/ or /usr/share/fonts/')
  }

  let bold: Buffer
  if (existsSync(primaryBold)) {
    bold = readFileSync(primaryBold)
  } else if (existsSync(fallbackBold)) {
    bold = readFileSync(fallbackBold)
  } else {
    bold = reg
  }

  cachedFonts = [
    { name: 'Inter', data: reg, weight: 400, style: 'normal' },
    { name: 'Inter', data: bold, weight: 700, style: 'normal' },
  ]
  return cachedFonts
}

let arimoFontBuffer: Buffer | null = null
let arimoOtFont: any = null

function loadArimoFont(): { data: Buffer; ot: any } {
  if (arimoFontBuffer && arimoOtFont) {
    return { data: arimoFontBuffer, ot: arimoOtFont }
  }
  const fontPath = join(process.cwd(), 'assets', 'fonts', 'Arimo-Regular.ttf')
  if (!existsSync(fontPath)) {
    throw new Error(`Font file not found: ${fontPath}`)
  }
  arimoFontBuffer = readFileSync(fontPath)
  arimoOtFont = opentype.parse(
    arimoFontBuffer.buffer.slice(arimoFontBuffer.byteOffset, arimoFontBuffer.byteOffset + arimoFontBuffer.byteLength),
  )
  return { data: arimoFontBuffer, ot: arimoOtFont }
}

async function prepareAvatarDataUrl(buf?: Buffer, maxSize = 120): Promise<string | null> {
  if (!buf || buf.length === 0) return null
  try {
    const resized = await sharp(buf)
      .resize(maxSize, maxSize, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer()
    return `data:image/jpeg;base64,${resized.toString('base64')}`
  } catch {
    return null
  }
}

function buildEmojiCodepointCandidates(segment: string): string[] {
  const exact = [...segment]
    .map((c) => c.codePointAt(0)?.toString(16).toLowerCase())
    .filter((x): x is string => Boolean(x))
  const stripped = [...segment.replace(/\uFE0F/g, '')]
    .map((c) => c.codePointAt(0)?.toString(16).toLowerCase())
    .filter((x): x is string => Boolean(x))

  const candidates: string[] = []
  const pushUnique = (val: string) => {
    if (val && !candidates.includes(val)) candidates.push(val)
  }
  if (exact.length > 0) pushUnique(exact.join('-'))
  if (stripped.length > 0) pushUnique(stripped.join('-'))
  if (exact.length === 1 && !exact[0]!.includes('fe0f')) {
    pushUnique(`${exact[0]}-fe0f`)
  }
  return candidates
}

async function loadEmojiAsset(code: string, segment: string): Promise<string> {
  if (code !== 'emoji') return ''

  const candidates = buildEmojiCodepointCandidates(segment)
  if (candidates.length === 0) return ''

  const cacheKey = candidates[0]!
  if (emojiAssetCache.has(cacheKey)) {
    return emojiAssetCache.get(cacheKey)!
  }

  // 1. Primary: Latest Apple Color Emoji v16.0.0 (iOS 18+/26 style)
  for (const cp of candidates) {
    try {
      const res = await fetch(`${APPLE_EMOJI_BASE_URL}/${cp}.png`, { signal: AbortSignal.timeout(2500) })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > 0) {
          const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
          cacheEmoji(cacheKey, dataUrl)
          return dataUrl
        }
      }
    } catch {
      // continue to next candidate or fallback
    }
  }

  // 2. Fallback: Twemoji SVG
  for (const cp of candidates) {
    try {
      const res = await fetch(`${TWEMOJI_BASE_URL}/${cp}.svg`, { signal: AbortSignal.timeout(2500) })
      if (res.ok) {
        const text = await res.text()
        const dataUrl = `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`
        cacheEmoji(cacheKey, dataUrl)
        return dataUrl
      }
    } catch {
      // ignore fallback failure
    }
  }
  return ''
}

const b64 = (s: string) => Buffer.from(s).toString('base64')
const svgIcon = (pathD: string, color = '#fff', size = 20, viewBox = '0 0 24 24', strokeWidth = 2): any => ({
  type: 'img',
  props: {
    width: size,
    height: size,
    src:
      'data:image/svg+xml;base64,' +
      b64(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${pathD}</svg>`,
      ),
  },
})

function getAccentColor(name: string): string {
  const palette = ['#53bdeb', '#ff8a65', '#e57373', '#81c784', '#ba68c8', '#ffd54f', '#4dd0e1', '#aed581']
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i)
    hash |= 0
  }
  return palette[Math.abs(hash) % palette.length]!
}

export class VisualCardService {
  /**
   * Render WhatsApp iOS 26 (Liquid Glass) IQC Phone Screen / Sticker (!iqc & !iqcs)
   */
  static async renderIqc(options: IqcOptions): Promise<Buffer> {
    const fonts = loadFonts()
    const time = options.time?.trim().slice(0, 12) || new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    const text = options.text.trim().slice(0, 500)
    if (!text) throw new Error('IQC text must not be empty')

    const isSticker = Boolean(options.stickerMode)
    const isLight = options.theme === 'light'
    const isOutgoing = Boolean(options.isOutgoing)
    const senderName = options.senderName?.trim().slice(0, 50)
    const displayContact = senderName || 'WhatsApp'
    const nameColor = senderName ? getAccentColor(senderName) : '#53bdeb'
    const battery = Math.max(1, Math.min(100, Math.round(options.battery ?? 88)))
    const signalStrength = Math.max(1, Math.min(4, Math.round(options.signalStrength ?? 4)))
    const carrier = (options.carrier?.trim().slice(0, 14) || '5G').toUpperCase()

    const W = isSticker ? 580 : 680
    const H = 1360
    const avatarBase64 = await prepareAvatarDataUrl(options.avatarBuffer, 96)

    const palette = isLight
      ? {
          bg: '#efeae2',
          doodleStroke: 'rgba(130, 118, 102, 0.14)',
          dimOverlay: 'rgba(225, 222, 216, 0.72)',
          statusFg: '#111b21',
          batteryFill: battery <= 20 ? '#ff3b30' : '#111b21',
          batteryText: '#ffffff',
          glassBg: 'rgba(255, 255, 255, 0.78)',
          glassBorder: 'rgba(255, 255, 255, 0.92)',
          glassHighlight: 'rgba(0, 0, 0, 0.06)',
          menuText: '#111b21',
          menuIcon: '#1c1c1e',
          menuDivider: 'rgba(0, 0, 0, 0.08)',
          plusBg: 'rgba(120, 120, 128, 0.16)',
          plusFg: '#3a3a3c',
          bubbleBg: isOutgoing ? '#d9fdd3' : '#ffffff',
          bubbleFg: '#111b21',
          metaFg: '#667781',
          replyBg: 'rgba(0, 0, 0, 0.05)',
          replyFg: '#54656f',
          inputBg: 'rgba(255, 255, 255, 0.78)',
          accentGreen: '#1dab61',
          bgBubbleOther: 'rgba(255, 255, 255, 0.55)',
          bgBubbleSelf: 'rgba(217, 253, 211, 0.55)',
        }
      : {
          bg: '#0b141a',
          doodleStroke: 'rgba(255, 255, 255, 0.055)',
          dimOverlay: 'rgba(7, 11, 14, 0.72)',
          statusFg: '#ffffff',
          batteryFill: battery <= 20 ? '#ff453a' : '#ffffff',
          batteryText: '#0b141a',
          glassBg: 'rgba(42, 46, 50, 0.84)',
          glassBorder: 'rgba(255, 255, 255, 0.15)',
          glassHighlight: 'rgba(255, 255, 255, 0.10)',
          menuText: '#f2f4f5',
          menuIcon: '#d1d5db',
          menuDivider: 'rgba(255, 255, 255, 0.09)',
          plusBg: 'rgba(92, 98, 104, 0.88)',
          plusFg: '#e5e7eb',
          bubbleBg: isOutgoing ? '#005c4b' : '#202c33',
          bubbleFg: '#e9edef',
          metaFg: isOutgoing ? '#a4c4bd' : '#8696a0',
          replyBg: 'rgba(11, 20, 26, 0.42)',
          replyFg: '#aebac1',
          inputBg: 'rgba(34, 40, 44, 0.82)',
          accentGreen: '#25d366',
          bgBubbleOther: 'rgba(32, 44, 51, 0.48)',
          bgBubbleSelf: 'rgba(0, 92, 75, 0.46)',
        }

    // Authentic WhatsApp Doodle Wallpaper (organic rotated scatter + blurred focus overlay)
    const wallpaperSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="doodle" width="220" height="220" patternUnits="userSpaceOnUse" patternTransform="rotate(-14)">
      <g stroke="${palette.doodleStroke}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="32" cy="30" r="11"/>
        <circle cx="28" cy="27" r="1" fill="${palette.doodleStroke}"/>
        <circle cx="36" cy="27" r="1" fill="${palette.doodleStroke}"/>
        <path d="M27 33 Q32 37 37 33"/>
        <g transform="translate(110 18) rotate(22)">
          <path d="M12 6 c-4-5-12-3-12 4 0 7 12 14 12 14s12-7 12-14c0-7-8-9-12-4z"/>
        </g>
        <g transform="translate(178 36) rotate(-18)">
          <path d="M0 10 l10 -12 l8 14 l-14 4 z"/>
        </g>
        <g transform="translate(22 104) rotate(12)">
          <rect x="0" y="0" width="22" height="17" rx="4"/>
          <path d="M0 6 h22 M6 -4 v5 M16 -4 v5"/>
        </g>
        <g transform="translate(95 92) rotate(-25)">
          <path d="M12 0 l3 7 l8 1 l-5 5 l1 8 l-7 -4 l-7 4 l1 -8 l-5 -5 l8 -1 z"/>
        </g>
        <g transform="translate(166 118) rotate(28)">
          <path d="M4 4 c6-7 16 2 8 12 c-4 5-12 2-8-12z"/>
        </g>
        <g transform="translate(42 170) rotate(-15)">
          <path d="M12 0 a11 11 0 1 0 11 11 a8 8 0 1 1 -11 -11z"/>
        </g>
        <g transform="translate(124 162) rotate(16)">
          <path d="M4 18 v-14 l15 -4 v14"/>
          <circle cx="2" cy="19" r="3.5"/>
          <circle cx="17" cy="15" r="3.5"/>
        </g>
        <g transform="translate(185 184) rotate(-8)">
          <path d="M0 4 h20 l-3 11 h-14 z"/>
        </g>
      </g>
    </pattern>
    <filter id="bgBlur" x="-15%" y="-15%" width="130%" height="130%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
    <filter id="doodleBlur" x="-5%" y="-5%" width="110%" height="110%">
      <feGaussianBlur stdDeviation="2.5"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="${palette.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#doodle)" filter="url(#doodleBlur)"/>
  <g filter="url(#bgBlur)" opacity="0.88">
    <rect x="275" y="182" width="130" height="30" rx="15" fill="${palette.bgBubbleOther}"/>
    <rect x="28" y="236" width="330" height="70" rx="18" fill="${palette.bgBubbleOther}"/>
    <rect x="${W - 340}" y="324" width="312" height="60" rx="18" fill="${palette.bgBubbleSelf}"/>
    <rect x="28" y="404" width="250" height="58" rx="18" fill="${palette.bgBubbleOther}"/>
    <rect x="${W - 290}" y="1030" width="262" height="64" rx="18" fill="${palette.bgBubbleSelf}"/>
    <rect x="28" y="1112" width="310" height="62" rx="18" fill="${palette.bgBubbleOther}"/>
  </g>
  <rect width="${W}" height="${H}" fill="${palette.dimOverlay}"/>
</svg>`
    const wallpaperDataUrl = 'data:image/svg+xml;base64,' + b64(wallpaperSvg)

    const iconMap: Record<string, string> = {
      Balas: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
      Teruskan: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
      Salin: '<rect width="13" height="13" x="9" y="9" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      Info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
      'Beri Bintang': '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
      Sematkan: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
      Laporkan: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
      Hapus: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
      'Lainnya...': '<circle cx="12" cy="12" r="10"/><circle cx="8" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="16" cy="12" r="1" fill="currentColor"/>',
      Edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    }

    const defaultMenu = isOutgoing
      ? ['Balas', 'Teruskan', 'Salin', 'Info', 'Sematkan', 'Hapus', 'Lainnya...']
      : ['Balas', 'Teruskan', 'Salin', 'Info', 'Sematkan', 'Laporkan', 'Hapus', 'Lainnya...']
    const rawItems = options.menuItems && options.menuItems.length > 0 ? options.menuItems : defaultMenu
    const menuItems: [string, string][] = rawItems.map((item) => [
      item,
      iconMap[item] ?? '<path d="m9 18 6-6-6-6"/>',
    ])

    // Incoming/outgoing speech tail seamlessly fused to bottom bubble corner
    const bubbleTailSvg = isOutgoing
      ? {
          type: 'img',
          props: {
            width: 14,
            height: 20,
            style: { marginLeft: -2, marginBottom: 0 },
            src:
              'data:image/svg+xml;base64,' +
              b64(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 20"><path d="M0 0 L0 20 C7 20, 12 18, 14 15 C8 12, 4 6, 3 0 Z" fill="${palette.bubbleBg}"/></svg>`),
          },
        }
      : {
          type: 'img',
          props: {
            width: 14,
            height: 20,
            style: { marginRight: -2, marginBottom: 0 },
            src:
              'data:image/svg+xml;base64,' +
              b64(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 20"><path d="M14 0 L14 20 C7 20, 2 18, 0 15 C6 12, 10 6, 11 0 Z" fill="${palette.bubbleBg}"/></svg>`),
          },
        }

    const replyPreviewNode = options.reply?.text
      ? {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              backgroundColor: palette.replyBg,
              borderRadius: 10,
              overflow: 'hidden',
              marginBottom: 8,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    width: 4,
                    backgroundColor: '#ff4d6d',
                  },
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '6px 10px',
                    maxWidth: 420,
                  },
                  children: [
                    {
                      type: 'span',
                      props: {
                        style: { fontSize: 17, fontWeight: 700, color: '#ff4d6d', marginBottom: 2 },
                        children: options.reply.sender.slice(0, 40),
                      },
                    },
                    {
                      type: 'span',
                      props: {
                        style: { fontSize: 17, color: palette.replyFg, lineHeight: 1.25 },
                        children: options.reply.text.trim().slice(0, 110),
                      },
                    },
                  ],
                },
              },
            ],
          },
        }
      : null

    const bubbleChildren = [
      !isOutgoing && senderName
        ? {
            type: 'span',
            props: {
              style: {
                fontWeight: 700,
                fontSize: 21,
                color: nameColor,
                marginBottom: 4,
              },
              children: senderName,
            },
          }
        : null,
      replyPreviewNode,
      {
        type: 'div',
        props: {
          style: {
            fontSize: 27,
            lineHeight: 1.32,
            color: palette.bubbleFg,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
          children: text,
        },
      },
      {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 5,
            marginTop: 6,
          },
          children: [
            {
              type: 'span',
              props: { style: { fontSize: 17, color: palette.metaFg }, children: time },
            },
            isOutgoing
              ? svgIcon('<path d="M20 6 9 17l-5-5"/><path d="m20 12-7 7-3-3"/>', '#53bdeb', 18, '0 0 24 24', 2.4)
              : null,
          ].filter(Boolean),
        },
      },
    ].filter(Boolean)

    // Reaction Pill (iOS 26 Liquid Glass, 7 Apple emojis + '+' tucked button)
    const reactionBar = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          alignItems: 'center',
          height: 78,
          padding: '0 14px 0 18px',
          borderRadius: 39,
          backgroundColor: palette.glassBg,
          border: `1.5px solid ${palette.glassBorder}`,
          boxShadow: '0 10px 28px rgba(0, 0, 0, 0.36)',
          marginBottom: 14,
          gap: 11,
        },
        children: [
          ...['👍', '❤️', '😂', '😮', '😢', '🙏', '💯'].map((e) => ({
            type: 'span',
            props: { style: { fontSize: 38, lineHeight: 1 }, children: e },
          })),
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                width: 46,
                height: 46,
                borderRadius: 23,
                backgroundColor: palette.plusBg,
                border: `1.5px solid ${palette.glassBorder}`,
                alignItems: 'center',
                justifyContent: 'center',
                marginLeft: 2,
              },
              children: [svgIcon('<path d="M12 5v14M5 12h14"/>', palette.plusFg, 24, '0 0 24 24', 2.4)],
            },
          },
        ],
      },
    }

    const bubbleRow = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: isOutgoing ? 'flex-end' : 'flex-start',
          marginBottom: 14,
        },
        children: isOutgoing
          ? [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 130,
                    maxWidth: isSticker ? 470 : 510,
                    padding: '12px 18px 10px',
                    borderRadius: '20px 20px 0 20px',
                    backgroundColor: palette.bubbleBg,
                  },
                  children: bubbleChildren,
                },
              },
              bubbleTailSvg,
            ]
          : [
              bubbleTailSvg,
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 130,
                    maxWidth: isSticker ? 470 : 510,
                    padding: '12px 18px 10px',
                    borderRadius: '20px 20px 20px 0',
                    backgroundColor: palette.bubbleBg,
                  },
                  children: bubbleChildren,
                },
              },
            ],
      },
    }

    const contextMenuCard = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          width: 368,
          borderRadius: 28,
          backgroundColor: palette.glassBg,
          border: `1.5px solid ${palette.glassBorder}`,
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.44)',
          padding: '8px',
        },
        children: menuItems.map(([label, iconD], idx) => {
          const isFirst = idx === 0
          const isDelete = label === 'Hapus'
          const isMore = label === 'Lainnya...'
          const prevIsDelete = idx > 0 && menuItems[idx - 1]?.[0] === 'Hapus'
          const fg = isDelete ? '#ff453a' : palette.menuText
          const iconFg = isDelete ? '#ff453a' : palette.menuIcon

          return {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
              },
              children: [
                isMore || prevIsDelete
                  ? {
                      type: 'div',
                      props: {
                        style: {
                          height: 1,
                          backgroundColor: palette.menuDivider,
                          margin: '4px 12px',
                        },
                      },
                    }
                  : null,
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 16,
                      padding: '13px 18px',
                      borderRadius: 18,
                      backgroundColor: 'transparent',
                    },
                    children: [
                      svgIcon(iconD, iconFg, 24, '0 0 24 24', 2),
                      {
                        type: 'span',
                        props: {
                          style: {
                            fontSize: 23,
                            color: fg,
                            fontWeight: 400,
                          },
                          children: label,
                        },
                      },
                    ],
                  },
                },
              ].filter(Boolean),
            },
          }
        }),
      },
    }

    // Sticker mode: centered transparent cutout with clean margins (zero letterbox)
    if (isSticker) {
      const stickerVdom = {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: W,
            padding: '28px 28px',
            backgroundColor: 'transparent',
            alignItems: 'center',
          },
          children: [
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: isOutgoing ? 'flex-end' : 'flex-start',
                },
                children: [reactionBar, bubbleRow, contextMenuCard],
              },
            },
          ],
        },
      }
      const svg = await satori(stickerVdom as any, {
        width: W,
        fonts,
        loadAdditionalAsset: loadEmojiAsset,
      })
      const resvg = new Resvg(svg, { fitTo: { mode: 'original' } })
      const rawPng = resvg.render().asPng()
      return sharp(rawPng)
        .trim({ threshold: 1 })
        .extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
        .catch(() => rawPng)
    }

    // Full IQC iPhone Screen (iOS 26 Status Bar + Floating Header + Focus Overlay + Input Bar + Home Indicator)
    const signalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="18" viewBox="0 0 26 18">
      <rect x="1" y="12" width="4.5" height="5" rx="1.2" fill="${palette.statusFg}" opacity="${signalStrength >= 1 ? 1 : 0.3}"/>
      <rect x="7.5" y="9" width="4.5" height="8" rx="1.2" fill="${palette.statusFg}" opacity="${signalStrength >= 2 ? 1 : 0.3}"/>
      <rect x="14" y="5" width="4.5" height="12" rx="1.2" fill="${palette.statusFg}" opacity="${signalStrength >= 3 ? 1 : 0.3}"/>
      <rect x="20.5" y="1" width="4.5" height="16" rx="1.2" fill="${palette.statusFg}" opacity="${signalStrength >= 4 ? 1 : 0.3}"/>
    </svg>`

    const batteryTrack = isLight ? 'rgba(0, 0, 0, 0.22)' : 'rgba(255, 255, 255, 0.28)'
    const batteryColor = battery <= 20 ? '#ff3b30' : isLight ? '#1c1c1e' : '#ffffff'
    const batterySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="22" viewBox="0 0 44 22">
      <rect x="1" y="1" width="38" height="20" rx="6" fill="${batteryTrack}"/>
      <rect x="1" y="1" width="${Math.max(8, Math.round((38 * battery) / 100))}" height="20" rx="6" fill="${batteryColor}"/>
      <path d="M40.5 7.5 C42.2 8, 42.2 14, 40.5 14.5 Z" fill="${batteryTrack}"/>
    </svg>`

    const headerAvatarNode = avatarBase64
      ? {
          type: 'img',
          props: {
            width: 42,
            height: 42,
            src: avatarBase64,
            style: { borderRadius: 21, objectFit: 'cover' },
          },
        }
      : {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: 42,
              height: 42,
              borderRadius: 21,
              backgroundColor: nameColor,
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontWeight: 700,
              fontSize: 19,
            },
            children: displayContact.charAt(0).toUpperCase(),
          },
        }

    const vdom = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: W,
          height: H,
          backgroundImage: `url('${wallpaperDataUrl}')`,
          backgroundSize: '100% 100%',
          padding: '16px 24px 14px',
        },
        children: [
          // Top chrome: Status Bar + WhatsApp iOS 26 Liquid Glass Header
          {
            type: 'div',
            props: {
              style: { display: 'flex', flexDirection: 'column', gap: 14 },
              children: [
                // iPhone Status Bar
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '4px 6px',
                      height: 48,
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: { display: 'flex', alignItems: 'center', gap: 6, width: 170 },
                          children: [
                            {
                              type: 'span',
                              props: {
                                style: { fontSize: 22, fontWeight: 700, color: palette.statusFg },
                                children: time,
                              },
                            },
                            svgIcon('<polygon points="3 11 22 2 13 21 11 13 3 11"/>', palette.statusFg, 15, '0 0 24 24', 2),
                          ],
                        },
                      },
                      // Dynamic Island (clean matte black pill)
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            width: 168,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: '#000000',
                          },
                        },
                      },
                      // Signal + Carrier + Battery
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: 8,
                            width: 185,
                          },
                          children: [
                            {
                              type: 'img',
                              props: { width: 24, height: 17, src: 'data:image/svg+xml;base64,' + b64(signalSvg) },
                            },
                            {
                              type: 'span',
                              props: {
                                style: { fontSize: 17, fontWeight: 700, color: palette.statusFg },
                                children: carrier,
                              },
                            },
                            {
                              type: 'div',
                              props: {
                                style: {
                                  display: 'flex',
                                  position: 'relative',
                                  width: 44,
                                  height: 22,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                },
                                children: [
                                  {
                                    type: 'img',
                                    props: {
                                      width: 44,
                                      height: 22,
                                      src: 'data:image/svg+xml;base64,' + b64(batterySvg),
                                      style: { position: 'absolute', left: 0, top: 0 },
                                    },
                                  },
                                  {
                                    type: 'span',
                                    props: {
                                      style: {
                                        fontSize: 13,
                                        fontWeight: 700,
                                        color: palette.batteryText,
                                        marginRight: 3,
                                      },
                                      children: String(battery),
                                    },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },

                // WhatsApp iOS 26 Floating Liquid Glass Header (dimmed behind overlay)
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      opacity: 0.38,
                    },
                    children: [
                      // Back + unread capsule
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            height: 54,
                            padding: '0 14px',
                            borderRadius: 27,
                            backgroundColor: palette.glassBg,
                            border: `1px solid ${palette.glassBorder}`,
                          },
                          children: [
                            svgIcon('<path d="m15 18-6-6 6-6"/>', palette.menuText, 22, '0 0 24 24', 2.4),
                            {
                              type: 'span',
                              props: { style: { fontSize: 19, fontWeight: 700, color: palette.menuText }, children: '1' },
                            },
                          ],
                        },
                      },
                      // Contact capsule
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            height: 58,
                            padding: '0 18px 0 8px',
                            borderRadius: 29,
                            backgroundColor: palette.glassBg,
                            border: `1px solid ${palette.glassBorder}`,
                            maxWidth: 340,
                          },
                          children: [
                            headerAvatarNode,
                            {
                              type: 'div',
                              props: {
                                style: { display: 'flex', flexDirection: 'column' },
                                children: [
                                  {
                                    type: 'span',
                                    props: {
                                      style: { fontSize: 19, fontWeight: 700, color: palette.menuText },
                                      children: displayContact.slice(0, 22),
                                    },
                                  },
                                  {
                                    type: 'span',
                                    props: {
                                      style: { fontSize: 14, color: palette.metaFg },
                                      children: isOutgoing ? 'online' : 'Grup WhatsApp • ketuk info',
                                    },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                      // Call actions capsule
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 18,
                            height: 54,
                            padding: '0 18px',
                            borderRadius: 27,
                            backgroundColor: palette.glassBg,
                            border: `1px solid ${palette.glassBorder}`,
                          },
                          children: [
                            svgIcon('<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>', palette.menuText, 22),
                            svgIcon('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>', palette.menuText, 20),
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },

          // Center Focus Stack: Reaction Pill + Bubble + Context Menu
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: isOutgoing ? 'flex-end' : 'flex-start',
                justifyContent: 'center',
                width: '100%',
              },
              children: [reactionBar, bubbleRow, contextMenuCard],
            },
          },

          // Bottom Chrome: Blurred Input Bar + Home Indicator
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 16,
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      width: '100%',
                      opacity: 0.38,
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            width: 52,
                            height: 52,
                            borderRadius: 26,
                            backgroundColor: palette.inputBg,
                            border: `1px solid ${palette.glassBorder}`,
                            alignItems: 'center',
                            justifyContent: 'center',
                          },
                          children: [svgIcon('<path d="M12 5v14M5 12h14"/>', palette.menuText, 24)],
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            flex: 1,
                            height: 52,
                            borderRadius: 26,
                            backgroundColor: palette.inputBg,
                            border: `1px solid ${palette.glassBorder}`,
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '0 18px',
                          },
                          children: [
                            {
                              type: 'span',
                              props: { style: { fontSize: 19, color: palette.metaFg }, children: 'Pesan' },
                            },
                            {
                              type: 'div',
                              props: {
                                style: { display: 'flex', alignItems: 'center', gap: 14 },
                                children: [
                                  svgIcon('<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>', palette.menuIcon, 20),
                                  svgIcon('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>', palette.menuIcon, 20),
                                ],
                              },
                            },
                          ],
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            width: 52,
                            height: 52,
                            borderRadius: 26,
                            backgroundColor: palette.accentGreen,
                            alignItems: 'center',
                            justifyContent: 'center',
                          },
                          children: [svgIcon('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>', '#ffffff', 22)],
                        },
                      },
                    ],
                  },
                },
                // iOS Home Indicator
                {
                  type: 'div',
                  props: {
                    style: {
                      width: 190,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: palette.statusFg,
                      opacity: 0.78,
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    }

    const svg = await satori(vdom as any, {
      width: W,
      height: H,
      fonts,
      loadAdditionalAsset: loadEmojiAsset,
    })

    const resvg = new Resvg(svg, { fitTo: { mode: 'original' } })
    return resvg.render().asPng()
  }

  /**
   * Render WhatsApp Native Dark Bubble Quote Chat (!qc) — High-Res & Proportional for 512x512 Stickers
   */
  static async renderQc(options: QcOptions): Promise<Buffer> {
    const fonts = loadFonts()
    const time = options.time?.trim().slice(0, 12) || new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    const text = options.text.trim().slice(0, 500)
    if (!text) throw new Error('QC text must not be empty')
    const senderName = options.senderName.trim().slice(0, 50) || 'User'
    const nameColor = getAccentColor(senderName)
    const isOutgoing = Boolean(options.isOutgoing)

    // Adapt canvas width & typography to text length so short/medium quotes fill 512x512 stickers clearly
    const textLen = text.length
    const hasNewlines = text.includes('\n')
    const scaleTier = textLen <= 28 && !hasNewlines ? 'short' : textLen <= 120 ? 'medium' : 'long'
    const canvasW = scaleTier === 'short' ? 420 : scaleTier === 'medium' ? 500 : 560
    const avatarSize = scaleTier === 'short' ? 70 : scaleTier === 'medium' ? 74 : 72
    const nameFontSize = scaleTier === 'short' ? 22 : scaleTier === 'medium' ? 23 : 21
    const bodyFontSize = scaleTier === 'short' ? 28 : scaleTier === 'medium' ? 25 : 22
    const timeFontSize = scaleTier === 'short' ? 16 : 16
    const maxBubbleWidth = canvasW - avatarSize - 44

    const avatarBase64 = await prepareAvatarDataUrl(options.avatarBuffer, 120)

    const avatarNode = avatarBase64
      ? {
          type: 'img',
          props: {
            width: avatarSize,
            height: avatarSize,
            src: avatarBase64,
            style: { borderRadius: avatarSize / 2, objectFit: 'cover' },
          },
        }
      : {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: avatarSize,
              height: avatarSize,
              borderRadius: avatarSize / 2,
              backgroundColor: nameColor,
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontWeight: 700,
              fontSize: Math.round(avatarSize * 0.44),
            },
            children: senderName.charAt(0).toUpperCase(),
          },
        }

    // Smooth curved WhatsApp top-left speech tail separated cleanly from avatar (no overlap!)
    const tailSvg = {
      type: 'img',
      props: {
        width: 14,
        height: 18,
        style: { marginLeft: 10, marginTop: 0, marginRight: -1 },
        src:
          'data:image/svg+xml;base64,' +
          b64('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 18"><path d="M0 0 C5 0, 10 0, 14 0 L14 18 C10 11, 5 6, 0 2 C-0.5 1.4, -0.4 0, 0 0 Z" fill="#202c33"/></svg>'),
      },
    }

    const vdom = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
          padding: '20px 20px',
          backgroundColor: 'transparent',
          width: canvasW,
        },
        children: [
          avatarNode,
          tailSvg,
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: '#202c33',
                borderRadius: '0 20px 20px 20px',
                padding: '14px 20px 12px',
                maxWidth: maxBubbleWidth,
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.22)',
              },
              children: [
                {
                  type: 'span',
                  props: {
                    style: {
                      fontWeight: 700,
                      fontSize: nameFontSize,
                      color: nameColor,
                      marginBottom: 4,
                    },
                    children: senderName,
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: {
                      fontWeight: 400,
                      fontSize: bodyFontSize,
                      color: '#e9edef',
                      lineHeight: 1.32,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    },
                    children: text,
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      gap: 5,
                      marginTop: 6,
                    },
                    children: [
                      {
                        type: 'span',
                        props: { style: { fontSize: timeFontSize, color: '#8696a0' }, children: time },
                      },
                      isOutgoing
                        ? svgIcon('<path d="M20 6 9 17l-5-5"/><path d="m20 12-7 7-3-3"/>', '#53bdeb', 16, '0 0 24 24', 2.5)
                        : null,
                    ].filter(Boolean),
                  },
                },
              ],
            },
          },
        ],
      },
    }

    const svg = await satori(vdom as any, {
      width: canvasW,
      fonts,
      loadAdditionalAsset: loadEmojiAsset,
    })

    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: canvasW * 2 } })
    const rawPng = resvg.render().asPng()
    // Trim excess whitespace then restore clean transparent outer margin so avatar & shadow never clip
    return sharp(rawPng)
      .trim({ threshold: 1 })
      .extend({ top: 18, bottom: 20, left: 20, right: 20, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
      .catch(() => rawPng)
  }

  /**
   * Render Twitter/X Post Mockup Card (!tweet)
   */
  static async renderTweet(options: TweetOptions): Promise<Buffer> {
    const fonts = loadFonts()
    const W = 620
    const now = new Date()
    const timeStr =
      options.time ??
      `${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

    const name = options.name.trim().slice(0, 50) || 'User'
    const handle = options.handle.trim().slice(0, 30).replace(/^@/, '') || 'user'
    const text = options.text.trim().slice(0, 500)
    if (!text) throw new Error('Tweet text must not be empty')

    const avatarBase64 = await prepareAvatarDataUrl(options.avatarBuffer, 80)

    const avatarNode = avatarBase64
      ? {
          type: 'img',
          props: {
            width: 48,
            height: 48,
            src: avatarBase64,
            style: { borderRadius: 24, objectFit: 'cover', marginRight: 12 },
          },
        }
      : {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: '#1d9bf0',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontWeight: 700,
              fontSize: 22,
              marginRight: 12,
            },
            children: name.charAt(0).toUpperCase(),
          },
        }

    const verifiedBadge = Boolean(options.verified)
      ? svgIcon(
          '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="#1d9bf0"/>',
          '#1d9bf0',
          18,
          '0 0 24 24',
          0,
        )
      : null

    const xLogo = svgIcon(
      '<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" fill="#e7e9ea"/>',
      '#e7e9ea',
      20,
      '0 0 24 24',
      0,
    )

    const vdom = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          width: W,
          backgroundColor: '#000000',
          border: '1px solid #2f3336',
          borderRadius: 20,
          padding: '20px 24px',
          color: '#e7e9ea',
        },
        children: [
          // Header: Avatar, Name, Handle, X logo
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 14,
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', alignItems: 'center' },
                    children: [
                      avatarNode,
                      {
                        type: 'div',
                        props: {
                          style: { display: 'flex', flexDirection: 'column' },
                          children: [
                            {
                              type: 'div',
                              props: {
                                style: { display: 'flex', alignItems: 'center', gap: 4 },
                                children: [
                                  {
                                    type: 'span',
                                    props: {
                                      style: { fontWeight: 700, fontSize: 17, color: '#e7e9ea' },
                                      children: name,
                                    },
                                  },
                                  verifiedBadge,
                                ].filter(Boolean),
                              },
                            },
                            {
                              type: 'span',
                              props: {
                                style: { fontSize: 14, color: '#71767b' },
                                children: `@${handle}`,
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                xLogo,
              ],
            },
          },

          // Body Text
          {
            type: 'div',
            props: {
              style: {
                fontSize: 19,
                lineHeight: 1.4,
                color: '#e7e9ea',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                marginBottom: 16,
              },
              children: text,
            },
          },

          // Timestamp
          {
            type: 'div',
            props: {
              style: {
                fontSize: 14,
                color: '#71767b',
                paddingBottom: 14,
                borderBottom: '1px solid #2f3336',
                marginBottom: 14,
              },
              children: timeStr,
            },
          },

          // Metrics Bar
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                justifyContent: 'space-around',
                alignItems: 'center',
                color: '#71767b',
                fontSize: 13,
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', alignItems: 'center', gap: 6 },
                    children: [
                      svgIcon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', '#71767b', 16),
                      options.replies ?? '48',
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', alignItems: 'center', gap: 6 },
                    children: [
                      svgIcon('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>', '#71767b', 16),
                      options.retweets ?? '128',
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', alignItems: 'center', gap: 6 },
                    children: [
                      svgIcon('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>', '#f91880', 16),
                      options.likes ?? '2.4K',
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', alignItems: 'center', gap: 6 },
                    children: [
                      svgIcon('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>', '#71767b', 16),
                      options.views ?? '14.2K',
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    }

    const svg = await satori(vdom as any, {
      width: W,
      fonts,
      loadAdditionalAsset: loadEmojiAsset,
    })

    const resvg = new Resvg(svg, { fitTo: { mode: 'original' } })
    return resvg.render().asPng()
  }

  /**
   * Render Social Profile Stalker Card (!ttstalk & !igstalk)
   */
  static async renderProfileCard(options: ProfileCardOptions): Promise<Buffer> {
    const fonts = loadFonts()
    const W = 580
    const isTiktok = options.platform === 'tiktok'
    const brandColor = isTiktok ? '#00f2fe' : '#e1306c'
    const brandLabel = isTiktok ? 'TIKTOK PROFILE' : 'INSTAGRAM PROFILE'

    const username = options.username.trim().slice(0, 50).replace(/^@/, '')
    const nickname = options.nickname.trim().slice(0, 60) || username
    const bio = options.bio?.trim().slice(0, 250)

    const avatarBase64 = await prepareAvatarDataUrl(options.avatarBuffer, 120)

    const avatarNode = avatarBase64
      ? {
          type: 'img',
          props: {
            width: 76,
            height: 76,
            src: avatarBase64,
            style: { borderRadius: 38, border: `2px solid ${brandColor}`, objectFit: 'cover' },
          },
        }
      : {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: 76,
              height: 76,
              borderRadius: 38,
              border: `2px solid ${brandColor}`,
              backgroundColor: '#2b302f',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontWeight: 700,
              fontSize: 32,
            },
            children: nickname.charAt(0).toUpperCase() || 'U',
          },
        }

    const verifiedBadge = Boolean(options.verified)
      ? svgIcon(
          '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="#00f2fe"/>',
          brandColor,
          18,
          '0 0 24 24',
          0,
        )
      : null

    const bioNode = bio
      ? {
          type: 'div',
          props: {
            style: {
              fontSize: 15,
              lineHeight: 1.4,
              color: '#c4cfd6',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              marginBottom: 20,
              backgroundColor: '#181d22',
              padding: '12px 16px',
              borderRadius: 14,
            },
            children: bio,
          },
        }
      : null

    const vdom = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          width: W,
          backgroundColor: '#111518',
          border: '1px solid #23292e',
          borderRadius: 24,
          padding: '24px 28px',
          color: '#ffffff',
        },
        children: [
          // Header Badge
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 20,
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 12px',
                      borderRadius: 12,
                      backgroundColor: brandColor,
                      color: isTiktok ? '#000000' : '#ffffff',
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: 1,
                    },
                    children: brandLabel,
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: { fontSize: 13, color: '#71767b' },
                    children: `@${username}`,
                  },
                },
              ],
            },
          },

          // User info row
          {
            type: 'div',
            props: {
              style: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 },
              children: [
                avatarNode,
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', flexDirection: 'column' },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: { display: 'flex', alignItems: 'center', gap: 6 },
                          children: [
                            {
                              type: 'span',
                              props: {
                                style: { fontWeight: 700, fontSize: 20, color: '#ffffff' },
                                children: nickname,
                              },
                            },
                            verifiedBadge,
                          ].filter(Boolean),
                        },
                      },
                      {
                        type: 'span',
                        props: {
                          style: { fontSize: 14, color: '#8899a6', marginTop: 2 },
                          children: `https://${isTiktok ? 'tiktok.com/@' : 'instagram.com/'}${username}`,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },

          // Bio
          bioNode,

          // Stats grid (3 boxes)
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      flex: 1,
                      backgroundColor: '#181d22',
                      padding: '12px 8px',
                      borderRadius: 14,
                    },
                    children: [
                      {
                        type: 'span',
                        props: { style: { fontWeight: 700, fontSize: 18, color: '#ffffff' }, children: options.stats.followers },
                      },
                      {
                        type: 'span',
                        props: { style: { fontSize: 12, color: '#71767b', marginTop: 2 }, children: 'Followers' },
                      },
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      flex: 1,
                      backgroundColor: '#181d22',
                      padding: '12px 8px',
                      borderRadius: 14,
                    },
                    children: [
                      {
                        type: 'span',
                        props: { style: { fontWeight: 700, fontSize: 18, color: '#ffffff' }, children: options.stats.following },
                      },
                      {
                        type: 'span',
                        props: { style: { fontSize: 12, color: '#71767b', marginTop: 2 }, children: 'Following' },
                      },
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      flex: 1,
                      backgroundColor: '#181d22',
                      padding: '12px 8px',
                      borderRadius: 14,
                    },
                    children: [
                      {
                        type: 'span',
                        props: { style: { fontWeight: 700, fontSize: 18, color: '#ffffff' }, children: options.stats.thirdStat },
                      },
                      {
                        type: 'span',
                        props: { style: { fontSize: 12, color: '#71767b', marginTop: 2 }, children: options.stats.thirdStatLabel },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ].filter(Boolean),
      },
    }

    const svg = await satori(vdom as any, {
      width: W,
      fonts,
      loadAdditionalAsset: loadEmojiAsset,
    })

    const resvg = new Resvg(svg, { fitTo: { mode: 'original' } })
    return resvg.render().asPng()
  }

  /**
   * Render Brat Album Cover Style Image
   */
  static async renderBrat(rawText: string): Promise<Buffer> {
    const text = rawText.trim()
    if (!text) {
      throw new Error('Teks tidak boleh kosong')
    }
    if (text.length > 200) {
      throw new Error('Teks terlalu panjang, maksimal 200 karakter')
    }

    const { data: fontData, ot: otFont } = loadArimoFont()
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)

    function measureWord(word: string, fontSize: number): number {
      let width = 0
      for (const ch of word) {
        if ((ch.codePointAt(0) ?? 0) > 0x2000) {
          width += fontSize
        } else {
          width += otFont.getAdvanceWidth(ch, fontSize) - 2
        }
      }
      return width
    }

    function layoutLines(wordsList: readonly string[], fontSize: number, maxW: number): string[][] | null {
      const lines: string[][] = []
      let currentLine: string[] = []
      let currentWidth = 0
      const minSpace = otFont.getAdvanceWidth(' ', fontSize) - 2

      for (const w of wordsList) {
        const wWidth = measureWord(w, fontSize)
        if (wWidth > maxW) return null

        if (currentLine.length === 0) {
          currentLine.push(w)
          currentWidth = wWidth
        } else if (currentWidth + minSpace + wWidth <= maxW) {
          currentLine.push(w)
          currentWidth += minSpace + wWidth
        } else {
          lines.push(currentLine)
          currentLine = [w]
          currentWidth = wWidth
        }
      }
      if (currentLine.length > 0) lines.push(currentLine)
      return lines
    }

    function findBestFontSize(wordsList: readonly string[], maxW = 640, maxH = 640): { fontSize: number; lines: string[][] } {
      let low = 20
      let high = 400
      let bestSize = low
      let bestLines: string[][] = [wordsList.slice()]

      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const lines = layoutLines(wordsList, mid, maxW)
        if (lines) {
          const totalH = lines.length * mid * 0.95
          if (totalH <= maxH) {
            bestSize = mid
            bestLines = lines
            low = mid + 1
            continue
          }
        }
        high = mid - 1
      }
      return { fontSize: bestSize, lines: bestLines }
    }

    const { fontSize, lines } = findBestFontSize(words, 640, 640)

    const vdom = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          width: 720,
          height: 720,
          backgroundColor: '#ffffff',
          padding: '40px',
          justifyContent: 'center',
        },
        children: lines.map((lineWords, idx) => {
          const isLast = idx === lines.length - 1
          const isSingle = lineWords.length === 1
          return {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'row',
                width: '100%',
                justifyContent: isLast || isSingle ? 'flex-start' : 'space-between',
                gap: isLast && !isSingle ? `${Math.round(fontSize * 0.25)}px` : '0px',
                lineHeight: 0.95,
              },
              children: lineWords.map((w) => ({
                type: 'span',
                props: {
                  style: {
                    fontSize: `${fontSize}px`,
                    letterSpacing: '-2px',
                    color: '#000000',
                    lineHeight: 0.95,
                  },
                  children: w,
                },
              })),
            },
          }
        }),
      },
    }

    const svg = await satori(vdom as any, {
      width: 720,
      height: 720,
      fonts: [{ name: 'Arimo', data: fontData, weight: 400, style: 'normal' }],
      loadAdditionalAsset: loadEmojiAsset,
    })

    const resvg = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } })
    const sharpPng = resvg.render().asPng()

    return sharp(sharpPng).blur(3).png().toBuffer()
  }

  /**
   * Helper: Convert any PNG Buffer into a 512x512 contained WebP sticker
   */
  static async pngToWebpSticker(pngBuffer: Buffer, size = 512): Promise<Buffer> {
    return sharp(pngBuffer)
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 90 })
      .toBuffer()
  }

  /**
   * Render dynamic Welcome / Leave Avatar Card (1024x611 Polaroid/Instagram pop-art)
   */
  static async renderWelcomeCard(options: WelcomeCardOptions): Promise<Buffer> {
    const isWelcome = options.type === 'welcome'
    const templateFileName = isWelcome ? 'welcome-template.png' : 'leave-template.png'
    const rootPath = join(process.cwd(), 'assets', templateFileName)
    const distPath = join(process.cwd(), 'dist', 'assets', templateFileName)
    const templatePath = existsSync(rootPath) ? rootPath : distPath

    let baseBuffer: Buffer
    try {
      baseBuffer = readFileSync(templatePath)
    } catch {
      baseBuffer = readFileSync(join(process.cwd(), 'assets', 'welcome-template.png'))
    }

    // Sanitize display name
    let cleanName = options.userName.trim()
    if (!cleanName || cleanName === '@' || /^[+0-9@:._-]+$/.test(cleanName)) {
      cleanName = isWelcome ? 'New Commoner' : 'Commoner'
    } else if (!cleanName.startsWith('@')) {
      cleanName = `@${cleanName}`
    }

    // 1. Process Avatar
    // Dashed photo box polygon mask (matching the 8° tilted polaroid frame):
    const maskSvg = `<svg width="1024" height="611" xmlns="http://www.w3.org/2000/svg">
      <polygon points="427,146 720,184 680,488 387,450" fill="#ffffff"/>
    </svg>`

    let avatarSource: Buffer
    if (options.avatarBuffer && options.avatarBuffer.length > 0) {
      try {
        avatarSource = await sharp(Buffer.from(options.avatarBuffer))
          .rotate()
          .resize(300, 310, { fit: 'cover' })
          .png()
          .toBuffer()
      } catch {
        avatarSource = await VisualCardService.createDefaultAvatar(300, 310, isWelcome)
      }
    } else {
      avatarSource = await VisualCardService.createDefaultAvatar(300, 310, isWelcome)
    }

    // Rotate around the measured slot centre; the mask protects the footer.
    const rotatedAvatar = await sharp(avatarSource)
      .rotate(7.5, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()

    const avMeta = await sharp(rotatedAvatar).metadata()
    const avLeft = Math.round(554 - (avMeta.width ?? 300) / 2)
    const avTop = Math.round(317 - (avMeta.height ?? 310) / 2)

    // Place avatar on transparent 1024x611 canvas and apply polygon mask
    const avatarCanvas = await sharp({
      create: {
        width: 1024,
        height: 611,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: rotatedAvatar, left: avLeft, top: avTop }])
      .png()
      .toBuffer()

    const maskedAvatar = await sharp(avatarCanvas)
      .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
      .png()
      .toBuffer()

    // 2. Process Username Overlay
    const safeUsername = cleanName
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;')

    const fontSize = safeUsername.length > 18 ? 16 : safeUsername.length > 14 ? 18 : 21
    const usernameSvg = `<svg width="240" height="40" xmlns="http://www.w3.org/2000/svg">
      <text x="120" y="27" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-weight="700" font-size="${fontSize}" fill="#1e293b" text-anchor="middle">
        ${safeUsername}
      </text>
    </svg>`

    const rotUsername = await sharp(Buffer.from(usernameSvg))
      .rotate(8.0, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()

    const userMeta = await sharp(rotUsername).metadata()
    const userLeft = Math.round(568 - (userMeta.width ?? 240) / 2)
    const userTop = Math.round(110 - (userMeta.height ?? 40) / 2)

    // 3. Composite everything onto the base template
    return sharp(baseBuffer)
      .composite([
        { input: maskedAvatar, left: 0, top: 0 },
        { input: rotUsername, left: userLeft, top: userTop },
      ])
      .png()
      .toBuffer()
  }

  /**
   * Render progressive Brat frame (512x512) with theme support (white | green | black)
   */
  static async renderBratFrame(rawText: string, theme: 'white' | 'green' | 'black' = 'white'): Promise<Buffer> {
    const text = rawText.trim() || 'brat'
    const { data: fontData, ot: otFont } = loadArimoFont()
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)

    const themeColors: Record<'white' | 'green' | 'black', { bg: string; fg: string }> = {
      white: { bg: '#ffffff', fg: '#000000' },
      green: { bg: '#8ace00', fg: '#000000' },
      black: { bg: '#000000', fg: '#ffffff' },
    }
    const { bg, fg } = themeColors[theme] ?? themeColors.white

    function measureWord(word: string, fontSize: number): number {
      let width = 0
      for (const ch of word) {
        if ((ch.codePointAt(0) ?? 0) > 0x2000) width += fontSize
        else width += otFont.getAdvanceWidth(ch, fontSize) - 2
      }
      return width
    }

    function layoutLines(wordsList: readonly string[], fontSize: number, maxW: number): string[][] | null {
      const lines: string[][] = []
      let currentLine: string[] = []
      let currentWidth = 0
      const minSpace = otFont.getAdvanceWidth(' ', fontSize) - 2
      for (const w of wordsList) {
        const wWidth = measureWord(w, fontSize)
        if (wWidth > maxW) return null
        if (currentLine.length === 0) {
          currentLine.push(w)
          currentWidth = wWidth
        } else if (currentWidth + minSpace + wWidth <= maxW) {
          currentLine.push(w)
          currentWidth += minSpace + wWidth
        } else {
          lines.push(currentLine)
          currentLine = [w]
          currentWidth = wWidth
        }
      }
      if (currentLine.length > 0) lines.push(currentLine)
      return lines
    }

    let low = 18
    let high = 160
    let bestSize = 24
    let bestLines: string[][] = [words.slice()]
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidateLines = layoutLines(words, mid, 440)
      if (candidateLines && candidateLines.length * mid * 1.05 <= 440) {
        bestSize = mid
        bestLines = candidateLines
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    const vdom = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          width: 512,
          height: 512,
          backgroundColor: bg,
          padding: '36px',
          justifyContent: 'center',
        },
        children: bestLines.map((lineWords) => ({
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              width: '100%',
              justifyContent: 'flex-start',
              gap: `${Math.round(bestSize * 0.25)}px`,
              lineHeight: 1.05,
            },
            children: lineWords.map((w) => ({
              type: 'span',
              props: {
                style: {
                  fontSize: `${bestSize}px`,
                  letterSpacing: '-1px',
                  color: fg,
                  lineHeight: 1.05,
                },
                children: w,
              },
            })),
          },
        })),
      },
    }

    const svg = await satori(vdom as any, {
      width: 512,
      height: 512,
      fonts: [{ name: 'Arimo', data: fontData, weight: 400, style: 'normal' }],
      loadAdditionalAsset: loadEmojiAsset,
    })
    const resvg = new Resvg(svg, { fitTo: { mode: 'original' } })
    const rawPng = resvg.render().asPng()
    return sharp(rawPng).blur(1.6).png().toBuffer()
  }

  /**
   * Render progressive Brat animated sticker (WebP) or video (MP4) in native TypeScript
   */
  static async renderBratVid(
    rawText: string,
    options: { theme?: 'white' | 'green' | 'black'; format?: 'webp' | 'mp4' } = {},
  ): Promise<Buffer> {
    const words = rawText.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) words.push('brat')
    const theme = options.theme ?? 'white'
    const format = options.format ?? 'webp'

    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { spawn } = await import('node:child_process')

    const tempDir = await mkdtemp(join(tmpdir(), 'allybot_bratvid_'))
    try {
      // Render all progressive word frames in parallel
      const frames = await Promise.all(
        words.map((_, idx) => VisualCardService.renderBratFrame(words.slice(0, idx + 1).join(' '), theme)),
      )

      let frameIdx = 1
      const writes: Promise<void>[] = []
      for (const frameBuf of frames) {
        const framePath = join(tempDir, `f${String(frameIdx).padStart(4, '0')}.png`)
        writes.push(writeFile(framePath, frameBuf))
        frameIdx++
      }

      // Hold final frame (~4 extra frames at 2.8fps)
      const lastFrame = frames[frames.length - 1]!
      for (let h = 0; h < 4; h++) {
        const holdPath = join(tempDir, `f${String(frameIdx).padStart(4, '0')}.png`)
        writes.push(writeFile(holdPath, lastFrame))
        frameIdx++
      }
      await Promise.all(writes)

      const outPath = join(tempDir, `out.${format}`)
      const ffmpegArgs =
        format === 'webp'
          ? [
              '-y',
              '-framerate', '2.8',
              '-i', join(tempDir, 'f%04d.png'),
              '-vcodec', 'libwebp',
              '-lossless', '0',
              '-compression_level', '4',
              '-q:v', '70',
              '-loop', '0',
              '-an',
              outPath,
            ]
          : [
              '-y',
              '-framerate', '2.8',
              '-i', join(tempDir, 'f%04d.png'),
              '-c:v', 'libx264',
              '-pix_fmt', 'yuv420p',
              '-crf', '23',
              '-preset', 'veryfast',
              '-movflags', '+faststart',
              outPath,
            ]

      await new Promise<void>((resolve, reject) => {
        const ff = spawn('ffmpeg', ffmpegArgs)
        let settled = false
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            ff.kill('SIGKILL')
            reject(new Error('ffmpeg bratvid timeout'))
          }
        }, 30_000)
        ff.once('error', (err) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(err)
          }
        })
        ff.once('close', (code) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(new Error(`ffmpeg bratvid exited with code ${code}`))
          }
        })
      })

      return await readFile(outPath)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Render 512x512 transparent meme text overlay PNG (with thick black stroke + white fill) in native TypeScript
   */
  static async renderSmemeOverlay(
    topText: string,
    bottomText: string,
    sizePercent = 50,
    bounds: { offsetY?: number; height?: number } = {},
  ): Promise<Buffer> {
    const fonts = loadFonts()
    const boldFont = fonts.find((f) => f.weight === 700)?.data ?? fonts[0]!.data
    const otFont = opentype.parse(
      boldFont.buffer.slice(boldFont.byteOffset, boldFont.byteOffset + boldFont.byteLength),
    )

    const targetSize = Math.max(16, Math.min(92, Math.round(sizePercent)))
    const minSize = Math.max(14, Math.floor(targetSize * 0.45))

    function measureLine(str: string, sz: number): number {
      let w = 0
      for (const ch of str) {
        if ((ch.codePointAt(0) ?? 0) > 0x2000) w += sz + 4
        else w += otFont.getAdvanceWidth(ch, sz)
      }
      return w
    }

    function fitLines(raw: string, maxW = 480, maxH = 180): { fontSize: number; stroke: number; lines: string[] } {
      const cleaned = raw.trim()
      if (!cleaned) return { fontSize: targetSize, stroke: 4, lines: [] }
      const words = cleaned.split(/\s+/).filter(Boolean)

      for (let sz = targetSize; sz >= minSize; sz -= 2) {
        const stroke = Math.max(3, Math.floor(sz * 0.12))
        const lines: string[] = []
        let curr = ''
        let valid = true

        for (const w of words) {
          const testLine = curr ? `${curr} ${w}` : w
          if (measureLine(testLine, sz) <= maxW) {
            curr = testLine
          } else {
            if (curr) lines.push(curr)
            if (measureLine(w, sz) > maxW) {
              valid = false
              break
            }
            curr = w
          }
        }
        if (!valid) continue
        if (curr) lines.push(curr)
        if (lines.length > 2 && sz > minSize) continue
        const totalH = lines.length * (sz + 8)
        if (totalH <= maxH || sz <= minSize) {
          return { fontSize: sz, stroke, lines }
        }
      }
      const fallbackStroke = Math.max(3, Math.floor(minSize * 0.12))
      return { fontSize: minSize, stroke: fallbackStroke, lines: [cleaned] }
    }

    function escapeXml(s: string): string {
      return s
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;')
    }

    const offsetY = bounds.offsetY ?? 0
    const imgH = bounds.height ?? 512
    const svgElements: string[] = []
    let topEndY = 0

    if (topText.trim()) {
      const { fontSize, stroke, lines } = fitLines(topText)
      let currY = Math.max(8, offsetY + 4) + fontSize
      for (const line of lines) {
        svgElements.push(
          `<text x="256" y="${currY}" text-anchor="middle" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff" stroke="#000000" stroke-width="${stroke * 2}" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(line)}</text>`,
        )
        currY += fontSize + 6
      }
      topEndY = currY - fontSize
    }

    if (bottomText.trim()) {
      const { fontSize, stroke, lines } = fitLines(bottomText)
      const totalH = lines.length * (fontSize + 6)
      const bottomLimit = Math.min(504, offsetY + imgH - 4)
      let currY = Math.max(topEndY + 8, bottomLimit - totalH) + fontSize
      for (const line of lines) {
        svgElements.push(
          `<text x="256" y="${currY}" text-anchor="middle" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff" stroke="#000000" stroke-width="${stroke * 2}" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(line)}</text>`,
        )
        currY += fontSize + 6
      }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${svgElements.join('')}</svg>`
    const fontFiles = [
      join(process.cwd(), 'assets', 'fonts', 'Inter-Bold.ttf'),
      join(process.cwd(), 'assets', 'fonts', 'Inter.ttf'),
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ].filter((p) => existsSync(p))

    const resvg = new Resvg(svg, {
      fitTo: { mode: 'original' },
      font: {
        fontFiles,
        loadSystemFonts: true,
        defaultFontFamily: 'Inter',
      },
    })
    return resvg.render().asPng()
  }

  /**
   * Render static 512x512 WebP Meme Sticker (!smeme) in pure in-memory TypeScript
   */
  static async renderSmemeStatic(
    imageBuffer: Buffer,
    topText: string,
    bottomText: string,
    sizePercent = 50,
  ): Promise<Buffer> {
    const resized = await sharp(imageBuffer)
      .resize(512, 512, {
        fit: 'inside',
        withoutEnlargement: false,
      })
      .png()
      .toBuffer()

    const meta = await sharp(resized).metadata()
    const nw = meta.width ?? 512
    const nh = meta.height ?? 512
    const offsetX = Math.floor((512 - nw) / 2)
    const offsetY = Math.floor((512 - nh) / 2)

    const overlayPng = await VisualCardService.renderSmemeOverlay(topText, bottomText, sizePercent, {
      offsetY,
      height: nh,
    })

    return sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: resized, left: offsetX, top: offsetY },
        { input: overlayPng, left: 0, top: 0 },
      ])
      .webp({ quality: 85 })
      .toBuffer()
  }

  private static async createDefaultAvatar(width: number, height: number, isWelcome: boolean): Promise<Buffer> {
    const bgColor = isWelcome ? '#3b82f6' : '#64748b'
    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 241, g: 245, b: 249, alpha: 1 },
      },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <circle cx="${width / 2}" cy="${height * 0.42}" r="${width * 0.22}" fill="${bgColor}"/>
            <path d="M ${width * 0.15} ${height * 0.95} C ${width * 0.15} ${height * 0.65}, ${width * 0.85} ${height * 0.65}, ${width * 0.85} ${height * 0.95} Z" fill="${bgColor}"/>
          </svg>`),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer()
  }
}

export interface WelcomeCardOptions {
  readonly type: 'welcome' | 'leave'
  readonly userName: string
  readonly groupName: string
  readonly avatarBuffer?: Buffer | Uint8Array
  readonly memberCount?: number
}

export const brat = VisualCardService.renderBrat
