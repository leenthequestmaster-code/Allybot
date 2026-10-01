import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'

export interface IqcOptions {
  readonly text: string
  readonly senderName?: string
  readonly time?: string
  readonly avatarBuffer?: Buffer
}

export interface QcOptions {
  readonly text: string
  readonly senderName: string
  readonly time?: string
  readonly avatarBuffer?: Buffer
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
const emojiSvgCache = new Map<string, string>()
const TWEMOJI_BASE_URL = process.env.TWEMOJI_BASE_URL ?? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg'

function cacheEmoji(key: string, val: string): void {
  if (emojiSvgCache.size >= MAX_EMOJI_CACHE_ENTRIES) {
    const first = emojiSvgCache.keys().next().value
    if (first) emojiSvgCache.delete(first)
  }
  emojiSvgCache.set(key, val)
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

async function loadEmojiAsset(code: string, segment: string): Promise<string> {
  if (code !== 'emoji') return ''

  const codepoints = [...(segment.includes('\u200d') ? segment : segment.replace(/\uFE0F/g, ''))]
    .map((c) => c.codePointAt(0)?.toString(16))
    .filter(Boolean)
    .join('-')

  if (!codepoints) return ''

  if (emojiSvgCache.has(codepoints)) {
    return emojiSvgCache.get(codepoints)!
  }

  const url = `${TWEMOJI_BASE_URL}/${codepoints}.svg`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const text = await res.text()
      const b64 = Buffer.from(text).toString('base64')
      const dataUrl = `data:image/svg+xml;base64,${b64}`
      cacheEmoji(codepoints, dataUrl)
      return dataUrl
    }
  } catch {
    // Network or timeout failure, return empty string so Satori ignores missing glyph
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
   * Render WhatsApp iOS Context-Menu style Quote Chat (!iqc)
   */
  static async renderIqc(options: IqcOptions): Promise<Buffer> {
    const fonts = loadFonts()
    const time = options.time ?? new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    const text = options.text.trim().slice(0, 500)
    if (!text) throw new Error('IQC text must not be empty')

    const W = 920
    const senderName = options.senderName?.trim().slice(0, 50)
    const nameColor = senderName ? getAccentColor(senderName) : '#53bdeb'

    const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 1200" preserveAspectRatio="none">
<defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="35"/></filter></defs>
<rect width="920" height="1200" fill="#0b0f0e"/>
<g filter="url(#b)">
  <rect x="300" y="-50" width="650" height="220" rx="50" fill="#1b4d38"/>
  <rect x="50" y="280" width="650" height="110" rx="40" fill="#2b302f"/>
  <rect x="50" y="410" width="600" height="110" rx="40" fill="#2b302f"/>
  <rect x="50" y="520" width="700" height="100" rx="40" fill="#252a29"/>
</g>
</svg>`
    const bgDataUrl = 'data:image/svg+xml;base64,' + b64(bgSvg)

    const menuItems: [string, string][] = [
      ['Balas', '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>'],
      ['Teruskan', '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'],
      ['Salin', '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'],
      ['Beri Bintang', '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'],
      ['Sematkan', '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'],
      ['Laporkan', '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'],
      ['Hapus', '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6M14 11v6"/>'],
    ]

    const bubbleChildren = [
      senderName
        ? {
            type: 'span',
            props: {
              style: {
                fontWeight: 700,
                fontSize: 22,
                color: nameColor,
                marginBottom: 8,
              },
              children: senderName,
            },
          }
        : null,
      {
        type: 'div',
        props: {
          style: {
            fontSize: 34,
            lineHeight: 1.35,
            color: '#fff',
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
            gap: 6,
            marginTop: 10,
          },
          children: [
            {
              type: 'span',
              props: { style: { fontSize: 22, color: '#888' }, children: time },
            },
            svgIcon('<path d="M20 6 9 17l-5-5"/><path d="m20 12-7 7-3-3"/>', '#53bdeb', 22, '0 0 24 24', 2.5),
          ],
        },
      },
    ].filter(Boolean)

    const vdom = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          width: W,
          position: 'relative',
          backgroundImage: `url('${bgDataUrl}')`,
          backgroundSize: '100% 100%',
          padding: '50px 45px',
          alignItems: 'flex-start',
        },
        children: [
          // Reactions bar
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 24,
                height: 104,
                padding: '0 26px',
                borderRadius: 52,
                backgroundColor: '#222726',
                marginBottom: 25,
              },
              children: [
                ...['👍', '❤️', '😂', '😮', '😢', '🙏'].map((e) => ({
                  type: 'span',
                  props: { style: { fontSize: 54 }, children: e },
                })),
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      width: 58,
                      height: 58,
                      borderRadius: 29,
                      backgroundColor: '#3a3f3e',
                      alignItems: 'center',
                      justifyContent: 'center',
                    },
                    children: [svgIcon('<path d="M12 5v14M5 12h14"/>', '#d5dad8', 30)],
                  },
                },
              ],
            },
          },

          // Bubble
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                minWidth: 280,
                maxWidth: 720,
                padding: '20px 30px 16px',
                borderRadius: 30,
                backgroundColor: '#1f2826',
                marginBottom: 35,
              },
              children: bubbleChildren,
            },
          },

          // Action Menu Card
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                width: 520,
                borderRadius: 28,
                backgroundColor: '#222726',
                overflow: 'hidden',
              },
              children: menuItems.map(([label, iconD], idx) => {
                const isDelete = label === 'Hapus'
                return {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '20px 28px',
                      borderBottom: idx < menuItems.length - 1 ? '1px solid #2e3433' : 'none',
                    },
                    children: [
                      {
                        type: 'span',
                        props: {
                          style: {
                            fontSize: 26,
                            color: isDelete ? '#ff453a' : '#fff',
                            fontWeight: isDelete ? 700 : 400,
                          },
                          children: label,
                        },
                      },
                      svgIcon(iconD, isDelete ? '#ff453a' : '#d5dad8', 26),
                    ],
                  },
                }
              }),
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
   * Render WhatsApp Native Dark Bubble Quote Chat (!qc)
   */
  static async renderQc(options: QcOptions): Promise<Buffer> {
    const fonts = loadFonts()
    const time = options.time ?? new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    const text = options.text.trim().slice(0, 500)
    if (!text) throw new Error('QC text must not be empty')
    const senderName = options.senderName.trim().slice(0, 50) || 'User'
    const nameColor = getAccentColor(senderName)

    const avatarBase64 = await prepareAvatarDataUrl(options.avatarBuffer, 80)

    const avatarNode = avatarBase64
      ? {
          type: 'img',
          props: {
            width: 50,
            height: 50,
            src: avatarBase64,
            style: { borderRadius: 25, objectFit: 'cover' },
          },
        }
      : {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: 50,
              height: 50,
              borderRadius: 25,
              backgroundColor: nameColor,
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontWeight: 700,
              fontSize: 22,
            },
            children: senderName.charAt(0).toUpperCase(),
          },
        }

    // Triangular tail connecting avatar to bubble
    const tailSvg = {
      type: 'img',
      props: {
        width: 10,
        height: 16,
        style: { marginTop: 12, marginRight: -2 },
        src:
          'data:image/svg+xml;base64,' +
          b64('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 16"><path d="M10 0 C6 6, 2 12, 0 16 L10 16 Z" fill="#202c33"/></svg>'),
      },
    }

    const vdom = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
          padding: '24px 20px',
          backgroundColor: 'transparent',
          width: 512,
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
                borderRadius: '0 14px 14px 14px',
                padding: '10px 16px',
                minWidth: 160,
                maxWidth: 410,
              },
              children: [
                {
                  type: 'span',
                  props: {
                    style: {
                      fontWeight: 700,
                      fontSize: 16,
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
                      fontSize: 18,
                      color: '#e9edef',
                      lineHeight: 1.35,
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
                      gap: 4,
                      marginTop: 6,
                    },
                    children: [
                      {
                        type: 'span',
                        props: { style: { fontSize: 12, color: '#8696a0' }, children: time },
                      },
                      svgIcon('<path d="M20 6 9 17l-5-5"/><path d="m20 12-7 7-3-3"/>', '#53bdeb', 14, '0 0 24 24', 2.5),
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
      width: 512,
      fonts,
      loadAdditionalAsset: loadEmojiAsset,
    })

    const resvg = new Resvg(svg, { fitTo: { mode: 'original' } })
    return resvg.render().asPng()
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
}
