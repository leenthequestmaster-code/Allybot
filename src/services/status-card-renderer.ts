import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

export interface StatusCardPayload {
  name: string
  gender: string
  age: number
  birthday: string
  race: string
  className: string
  element: string
  rank: string
  level: number
  willOfPath: string
  spirit?: string
  crew?: string
  profession?: string
  origin?: string
  titles?: readonly string[]
  motto?: string
  stats?: Record<string, unknown>
}

const W = 960
const H = 1280

const ELEMENT_COLORS: Record<string, [number, number, number]> = {
  Fire: [249, 115, 22],
  Water: [6, 182, 212],
  Wind: [45, 212, 191],
  Earth: [217, 119, 6],
  Nature: [16, 185, 129],
  Electro: [234, 179, 8],
  Ice: [56, 189, 248],
  Dark: [168, 85, 247],
  Light: [253, 224, 71],
  Sound: [99, 102, 241],
  Blood: [220, 38, 38],
  Bone: [226, 232, 240],
  Sand: [245, 158, 11],
  Mist: [148, 163, 184],
  Fruits: [236, 72, 153],
  Paper: [241, 245, 249],
  Magma: [234, 88, 12],
  Gel: [20, 184, 166],
}

let cachedFontFiles: string[] | null = null

function resolveFontFiles(): string[] {
  if (cachedFontFiles) return cachedFontFiles
  const candidates = [
    join(process.cwd(), 'assets', 'fonts', 'Inter.ttf'),
    join(process.cwd(), 'assets', 'fonts', 'Inter-Bold.ttf'),
    join(process.cwd(), 'assets', 'fonts', 'Arimo-Regular.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
  ]
  cachedFontFiles = candidates.filter((p) => {
    try {
      return existsSync(p) && readFileSync(p).length > 0
    } catch {
      return false
    }
  })
  return cachedFontFiles
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function rgb(c: readonly [number, number, number], alpha?: number): string {
  if (alpha !== undefined) {
    const a = alpha > 1 ? +(alpha / 255).toFixed(3) : alpha
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`
  }
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

function drawHudCornersSvg(
  box: readonly [number, number, number, number],
  length = 16,
  color: readonly [number, number, number] = [0, 229, 255],
  width = 2,
): string {
  const [x1, y1, x2, y2] = box
  const stroke = rgb(color)
  return [
    `<line x1="${x1}" y1="${y1}" x2="${x1 + length}" y2="${y1}" stroke="${stroke}" stroke-width="${width}" />`,
    `<line x1="${x1}" y1="${y1}" x2="${x1}" y2="${y1 + length}" stroke="${stroke}" stroke-width="${width}" />`,
    `<line x1="${x2}" y1="${y1}" x2="${x2 - length}" y2="${y1}" stroke="${stroke}" stroke-width="${width}" />`,
    `<line x1="${x2}" y1="${y1}" x2="${x2}" y2="${y1 + length}" stroke="${stroke}" stroke-width="${width}" />`,
    `<line x1="${x1}" y1="${y2}" x2="${x1 + length}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" />`,
    `<line x1="${x1}" y1="${y2}" x2="${x1}" y2="${y2 - length}" stroke="${stroke}" stroke-width="${width}" />`,
    `<line x1="${x2}" y1="${y2}" x2="${x2 - length}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" />`,
    `<line x1="${x2}" y1="${y2}" x2="${x2}" y2="${y2 - length}" stroke="${stroke}" stroke-width="${width}" />`,
  ].join('\n')
}

function drawHeaderSvg(titleType = 'CITIZEN DOSSIER'): string {
  return [
    `<text x="60" y="60" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="14" fill="rgba(0,229,255,0.78)">◈ ALLYSSEA WORLD SYSTEM ◈</text>`,
    `<text x="${W - 60}" y="62" text-anchor="end" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="16" fill="rgb(148,163,184)">${esc(titleType)}</text>`,
    `<line x1="60" y1="78" x2="${W - 60}" y2="78" stroke="rgba(0,229,255,0.35)" stroke-width="1" />`,
  ].join('\n')
}

function drawFooterSvg(subtext = 'ALLYSSEA WORLD SYSTEM · REAL-TIME REGISTRY'): string {
  return [
    `<line x1="60" y1="${H - 65}" x2="${W - 60}" y2="${H - 65}" stroke="rgb(30,41,59)" stroke-width="1" />`,
    `<text x="60" y="${H - 35}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="13" fill="rgb(148,163,184)">${esc(subtext)}</text>`,
    `<text x="${W - 60}" y="${H - 35}" text-anchor="end" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="13" fill="rgba(0,229,255,0.86)">STATUS: VERIFIED</text>`,
  ].join('\n')
}

function drawSegmentedBarSvg(
  x: number,
  y: number,
  w: number,
  h: number,
  current: number,
  maxVal: number,
  colorFill: readonly [number, number, number],
  colorBg: readonly [number, number, number],
  segments = 10,
): string {
  const rx = Math.floor(h / 2)
  const pct = Math.max(0, Math.min(1, current / Math.max(1, maxVal)))
  const fillW = Math.floor(w * pct)
  const parts: string[] = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${rgb(colorBg)}" />`,
  ]
  if (fillW > 0) {
    parts.push(`<rect x="${x}" y="${y}" width="${fillW}" height="${h}" rx="${rx}" fill="${rgb(colorFill)}" />`)
    if (fillW > 8) {
      parts.push(
        `<line x1="${x + 4}" y1="${y + 2}" x2="${x + fillW - 4}" y2="${y + 2}" stroke="rgba(255,255,255,0.47)" stroke-width="1" />`,
      )
    }
  }
  const segStep = w / segments
  for (let s = 1; s < segments; s++) {
    const sx = Math.floor(x + s * segStep)
    parts.push(`<line x1="${sx}" y1="${y}" x2="${sx}" y2="${y + h}" stroke="rgba(15,23,42,0.7)" stroke-width="1" />`)
  }
  return parts.join('\n')
}

function buildCharacterCardSvg(data: StatusCardPayload): string {
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="rgb(7,10,18)" />`,
    `<rect x="40" y="28" width="${W - 80}" height="${H - 56}" fill="none" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([40, 28, W - 40, H - 28], 24, [0, 229, 255], 3),
    drawHeaderSvg('STATUS WINDOW : CITIZEN DOSSIER'),
  ]

  const name = (data.name || 'Unknown').toUpperCase()
  const titles = data.titles ?? []
  const titleStr = titles.length > 0 && titles[0] ? `« ${titles[0]} »` : '« Warga Resmi Allyssea »'

  out.push(
    `<text x="60" y="144" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="46" fill="rgb(248,250,252)">${esc(name)}</text>`,
    `<text x="60" y="180" font-family="Inter, DejaVu Sans, sans-serif" font-weight="400" font-size="18" fill="rgb(56,189,248)">${esc(titleStr)}</text>`,
  )

  const rank = String(data.rank || 'E').toUpperCase()
  const level = String(data.level || '1')
  const element = String(data.element || 'Neutral')
  const will = String(data.willOfPath || 'Neutral')
  const elemColor = ELEMENT_COLORS[element] ?? [0, 229, 255]

  const badges: Array<[string, string, readonly [number, number, number]]> = [
    ['RANK', rank, [234, 179, 8]],
    ['LEVEL', level, [0, 229, 255]],
    ['ELEMENT', element, elemColor],
    ['PATH', will, [168, 85, 247]],
  ]

  let bx = 60
  const by = 205
  const bw = 192
  const bh = 54
  for (const [lbl, val, col] of badges) {
    out.push(
      `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6" fill="rgb(13,19,33)" stroke="${rgb(col)}" stroke-width="1" />`,
      `<text x="${bx + 14}" y="${by + 21}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="11" fill="rgb(148,163,184)">${esc(lbl)}</text>`,
      `<text x="${bx + 14}" y="${by + 44}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="17" fill="${rgb(col)}">${esc(val)}</text>`,
    )
    bx += bw + 20
  }

  // Main Identity Dossier Panel
  const [px1, py1, px2, py2] = [60, 280, W - 60, 685]
  out.push(
    `<rect x="${px1}" y="${py1}" width="${px2 - px1}" height="${py2 - py1}" rx="10" fill="rgb(11,16,28)" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([px1, py1, px2, py2], 16, [56, 189, 248], 2),
    `<text x="${px1 + 24}" y="${py1 + 34}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="16" fill="rgb(0,229,255)">IDENTITAS PRIBADI &amp; KLASIFIKASI</text>`,
    `<line x1="${px1 + 24}" y1="${py1 + 44}" x2="${px2 - 24}" y2="${py1 + 44}" stroke="rgb(30,41,59)" stroke-width="1" />`,
  )

  const fields: Array<[string, string]> = [
    ['RAS', data.race || '—'],
    ['KELAS', data.className || '—'],
    ['USIA / GENDER', `${data.age ?? '—'} Thn · ${data.gender || '—'}`],
    ['TANGGAL LAHIR', data.birthday || '—'],
    ['ASAL BENUA', data.origin || '—'],
    ['AFILIASI / CREW', data.crew || '—'],
    ['PROFESI', data.profession || '—'],
    ['SPIRIT PELINDUNG', data.spirit || '—'],
  ]

  let rowY = py1 + 60
  for (let i = 0; i < fields.length; i += 2) {
    const [lbl1, val1] = fields[i]!
    out.push(
      `<text x="${px1 + 28}" y="${rowY + 12}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="12" fill="rgb(148,163,184)">${esc(lbl1)}</text>`,
      `<text x="${px1 + 28}" y="${rowY + 36}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="18" fill="rgb(241,245,249)">${esc(val1)}</text>`,
    )
    if (i + 1 < fields.length) {
      const [lbl2, val2] = fields[i + 1]!
      out.push(
        `<text x="${px1 + 420}" y="${rowY + 12}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="12" fill="rgb(148,163,184)">${esc(lbl2)}</text>`,
        `<text x="${px1 + 420}" y="${rowY + 36}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="18" fill="rgb(241,245,249)">${esc(val2)}</text>`,
      )
    }
    rowY += 72
    if (i < fields.length - 2) {
      out.push(`<line x1="${px1 + 24}" y1="${rowY - 10}" x2="${px2 - 24}" y2="${rowY - 10}" stroke="rgb(20,28,45)" stroke-width="1" />`)
    }
  }

  // Vitality Snapshot Panel
  const stats = (data.stats ?? {}) as Record<string, any>
  const hp = Number(stats.hp ?? 800)
  const maxHp = Number(stats.maxHp ?? 800)
  const se = Number(stats.se ?? 200)
  const maxSe = Number(stats.maxSe ?? 200)

  const [vx1, vy1, vx2, vy2] = [60, 705, W - 60, 890]
  const barW = 640
  out.push(
    `<rect x="${vx1}" y="${vy1}" width="${vx2 - vx1}" height="${vy2 - vy1}" rx="10" fill="rgb(11,16,28)" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([vx1, vy1, vx2, vy2], 16, [0, 229, 255], 2),
    `<text x="${vx1 + 24}" y="${vy1 + 34}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="16" fill="rgb(0,229,255)">VITALITAS BINTANG (STATUS RINGKAS)</text>`,
    `<text x="${vx1 + 24}" y="${vy1 + 64}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="13" fill="rgb(255,75,120)">HP</text>`,
    `<text x="${vx2 - 24}" y="${vy1 + 65}" text-anchor="end" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="15" fill="rgb(241,245,249)">${esc(`${hp} / ${maxHp}`)}</text>`,
    drawSegmentedBarSvg(vx1 + 65, vy1 + 52, barW, 18, hp, maxHp, [255, 42, 95], [40, 16, 28]),
    `<text x="${vx1 + 24}" y="${vy1 + 100}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="13" fill="rgb(0,220,255)">SE</text>`,
    `<text x="${vx2 - 24}" y="${vy1 + 101}" text-anchor="end" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="15" fill="rgb(241,245,249)">${esc(`${se} / ${maxSe}`)}</text>`,
    drawSegmentedBarSvg(vx1 + 65, vy1 + 88, barW, 18, se, maxSe, [0, 210, 255], [14, 30, 50]),
  )

  const statKeys: Array<[string, number]> = [
    ['STR', Number(stats.str ?? 10)],
    ['DEF', Number(stats.def ?? 10)],
    ['MP', Number(stats.mp ?? 10)],
    ['RES', Number(stats.res ?? 10)],
    ['SPD', Number(stats.spd ?? 10)],
    ['INT', Number(stats.int ?? 10)],
    ['LCK', Number(stats.lck ?? 10)],
  ]

  let cx = vx1 + 24
  const cw = 104
  const ch = 38
  for (const [scode, sval] of statKeys) {
    out.push(
      `<rect x="${cx}" y="${vy1 + 124}" width="${cw}" height="${ch}" rx="4" fill="rgb(15,23,42)" stroke="rgb(30,41,59)" stroke-width="1" />`,
      `<text x="${cx + 8}" y="${vy1 + 147}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="11" fill="rgb(0,229,255)">${esc(scode)}</text>`,
      `<text x="${cx + cw - 8}" y="${vy1 + 148}" text-anchor="end" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="13" fill="rgb(241,245,249)">${esc(sval)}</text>`,
    )
    cx += cw + 14
  }

  // Motto Panel
  const motto = data.motto || 'Melangkah dalam bayang, mencari jalan terang di Allyssea.'
  const [mx1, my1, mx2, my2] = [60, 910, W - 60, 1065]
  out.push(
    `<rect x="${mx1}" y="${my1}" width="${mx2 - mx1}" height="${my2 - my1}" rx="10" fill="rgb(11,16,28)" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([mx1, my1, mx2, my2], 16, [56, 189, 248], 2),
    `<text x="${mx1 + 24}" y="${my1 + 34}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="16" fill="rgb(0,229,255)">MOTTO HIDUP &amp; TEKAD WARGA</text>`,
  )

  const words = motto.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let curLine: string[] = []
  for (const w of words) {
    curLine.push(w)
    if (curLine.join(' ').length > 65) {
      lines.push(curLine.join(' '))
      curLine = []
    }
  }
  if (curLine.length > 0) lines.push(curLine.join(' '))

  const visibleLines = lines.slice(0, 3)
  let mY = my1 + 65
  for (let idx = 0; idx < visibleLines.length; idx++) {
    const prefix = idx === 0 ? '“ ' : '  '
    const suffix = idx === visibleLines.length - 1 ? ' ”' : ''
    out.push(
      `<text x="${mx1 + 24}" y="${mY}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="400" font-size="15" fill="rgb(226,232,240)">${esc(`${prefix}${visibleLines[idx]}${suffix}`)}</text>`,
    )
    mY += 24
  }

  // Condition Status Box
  const [sx1, sy1, sx2, sy2] = [60, 1085, W - 60, 1155]
  out.push(
    `<rect x="${sx1}" y="${sy1}" width="${sx2 - sx1}" height="${sy2 - sy1}" rx="8" fill="rgb(11,16,28)" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([sx1, sy1, sx2, sy2], 14, [0, 229, 255], 2),
    `<text x="${sx1 + 24}" y="${sy1 + 26}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="11" fill="rgb(148,163,184)">KONDISI STATUS</text>`,
    `<text x="${sx1 + 24}" y="${sy1 + 50}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="15" fill="rgb(16,185,129)">NORMAL · BEBAS DEBUFF</text>`,
    `<text x="${sx2 - 24}" y="${sy1 + 26}" text-anchor="end" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="11" fill="rgb(148,163,184)">AFINITAS JIWA</text>`,
    `<text x="${sx2 - 24}" y="${sy1 + 50}" text-anchor="end" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="15" fill="rgb(0,229,255)">STABIL (100%)</text>`,
    drawFooterSvg('ALLYSSEA SYSTEM · PASPOR WARGA KANONIKAL'),
    `</svg>`,
  )

  return out.join('\n')
}

function buildStatsCardSvg(data: StatusCardPayload): string {
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="rgb(7,10,18)" />`,
    `<rect x="40" y="28" width="${W - 80}" height="${H - 56}" fill="none" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([40, 28, W - 40, H - 28], 24, [0, 229, 255], 3),
    drawHeaderSvg('STATUS WINDOW : TACTICAL MATRIX'),
  ]

  const name = (data.name || 'Unknown').toUpperCase()
  const race = data.race || 'Human'
  const cls = data.className || 'Knight'
  const rank = data.rank || 'E'
  const lvl = data.level || 1

  out.push(
    `<text x="60" y="144" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="46" fill="rgb(248,250,252)">${esc(name)}</text>`,
    `<text x="60" y="180" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="17" fill="rgb(0,229,255)">${esc(`RANK ${rank}  ·  LEVEL ${lvl}  ·  ${race.toUpperCase()} ${cls.toUpperCase()}`)}</text>`,
  )

  const stats = (data.stats ?? {}) as Record<string, any>
  const hp = Number(stats.hp ?? 800)
  const maxHp = Number(stats.maxHp ?? 800)
  const se = Number(stats.se ?? 200)
  const maxSe = Number(stats.maxSe ?? 200)

  const [gx1, gy1, gx2, gy2] = [60, 205, W - 60, 375]
  const barFullW = gx2 - gx1 - 48

  out.push(
    `<rect x="${gx1}" y="${gy1}" width="${gx2 - gx1}" height="${gy2 - gy1}" rx="10" fill="rgb(11,16,28)" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([gx1, gy1, gx2, gy2], 16, [0, 229, 255], 2),
    `<text x="${gx1 + 24}" y="${gy1 + 33}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="15" fill="rgb(0,229,255)">VITALITAS BINTANG (CORE GAUGES)</text>`,
    `<text x="${gx1 + 24}" y="${gy1 + 64}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="14" fill="rgb(255,75,120)">HP (HEALTH POINTS)</text>`,
    `<text x="${gx2 - 24}" y="${gy1 + 66}" text-anchor="end" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="16" fill="rgb(248,250,252)">${esc(`${hp} / ${maxHp}`)}</text>`,
    drawSegmentedBarSvg(gx1 + 24, gy1 + 74, barFullW, 20, hp, maxHp, [255, 42, 95], [40, 16, 28]),
    `<text x="${gx1 + 24}" y="${gy1 + 120}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="14" fill="rgb(0,220,255)">SE (SPIRIT ENERGY)</text>`,
    `<text x="${gx2 - 24}" y="${gy1 + 122}" text-anchor="end" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="16" fill="rgb(248,250,252)">${esc(`${se} / ${maxSe}`)}</text>`,
    drawSegmentedBarSvg(gx1 + 24, gy1 + 130, barFullW, 20, se, maxSe, [0, 210, 255], [14, 30, 50]),
  )

  // 8-Card Symmetrical Combat Attribute Matrix (2 cols x 4 rows)
  const [mx1, my1, mx2, my2] = [60, 395, W - 60, 890]
  out.push(
    `<rect x="${mx1}" y="${my1}" width="${mx2 - mx1}" height="${my2 - my1}" rx="10" fill="rgb(11,16,28)" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([mx1, my1, mx2, my2], 16, [56, 189, 248], 2),
    `<text x="${mx1 + 24}" y="${my1 + 33}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="15" fill="rgb(0,229,255)">MATRIKS ATRIBUT TEMPUR (7 PILAR)</text>`,
  )

  const allocMap = (stats.allocatedTokens ?? {}) as Record<string, number>
  const strVal = Number(stats.str ?? 10)
  const defVal = Number(stats.def ?? 10)
  const mpVal = Number(stats.mp ?? 10)
  const resVal = Number(stats.res ?? 10)
  const spdVal = Number(stats.spd ?? 10)
  const intVal = Number(stats.int ?? 10)
  const lckVal = Number(stats.lck ?? 10)
  const totalStats = strVal + defVal + mpVal + resVal + spdVal + intVal + lckVal

  const attrList: Array<[string, string, string, number, number, readonly [number, number, number]]> = [
    ['STR', 'STRENGTH', 'Fisik / Daya Rusak', strVal, Number(allocMap.str ?? 0), [0, 229, 255]],
    ['DEF', 'DEFENSE', 'Ketahanan / Armor', defVal, Number(allocMap.def ?? 0), [0, 229, 255]],
    ['MP', 'MAGIC POWER', 'Kapasitas / Daya Sihir', mpVal, Number(allocMap.mp ?? 0), [0, 229, 255]],
    ['RES', 'RESISTANCE', 'Resistensi Elemen', resVal, Number(allocMap.res ?? 0), [0, 229, 255]],
    ['SPD', 'SPEED / AGILITY', 'Kelincahan / Refleks', spdVal, Number(allocMap.spd ?? 0), [0, 229, 255]],
    ['INT', 'INTELLIGENCE', 'Akurasi / Wawasan', intVal, Number(allocMap.int ?? 0), [0, 229, 255]],
    ['LCK', 'LUCK / FORTUNE', 'Keberuntungan / Fatalitas', lckVal, Number(allocMap.lck ?? 0), [0, 229, 255]],
    ['TOT', 'TOTAL ATRIBUT', 'Akumulasi Poin Stat', totalStats, 0, [234, 179, 8]],
  ]

  const cardW = 385
  const cardH = 88
  const gridStartX = mx1 + 24
  const gridStartY = my1 + 52

  for (let idx = 0; idx < attrList.length; idx++) {
    const [code, fullName, desc, val, alloc, codeCol] = attrList[idx]!
    const col = idx % 2
    const row = Math.floor(idx / 2)
    const cx = gridStartX + col * (cardW + 22)
    const cy = gridStartY + row * (cardH + 10)

    out.push(
      `<rect x="${cx}" y="${cy}" width="${cardW}" height="${cardH}" rx="6" fill="rgb(15,23,42)" stroke="rgb(30,41,59)" stroke-width="1" />`,
      `<text x="${cx + 16}" y="${cy + 34}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="20" fill="${rgb(codeCol)}">${esc(code)}</text>`,
      `<text x="${cx + 70}" y="${cy + 28}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="13" fill="rgb(241,245,249)">${esc(fullName)}</text>`,
      `<text x="${cx + 70}" y="${cy + 46}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="400" font-size="11" fill="rgb(148,163,184)">${esc(desc)}</text>`,
      `<text x="${cx + cardW - 18}" y="${cy + 42}" text-anchor="end" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="26" fill="rgb(248,250,252)">${esc(val)}</text>`,
    )
    if (alloc > 0) {
      out.push(
        `<text x="${cx + cardW - 18}" y="${cy + 64}" text-anchor="end" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="11" fill="rgb(234,179,8)">${esc(`+${alloc} ALLOC`)}</text>`,
      )
    }
  }

  // Racial Trait
  const trait = String(stats.trait || 'Versatility')
  const [rx1, ry1, rx2, ry2] = [60, 908, W - 60, 980]
  out.push(
    `<rect x="${rx1}" y="${ry1}" width="${rx2 - rx1}" height="${ry2 - ry1}" rx="8" fill="rgb(11,16,28)" stroke="rgb(30,41,59)" stroke-width="1" />`,
    drawHudCornersSvg([rx1, ry1, rx2, ry2], 16, [56, 189, 248], 2),
    `<text x="${rx1 + 20}" y="${ry1 + 27}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="11" fill="rgb(148,163,184)">KARAKTERISTIK RASIAL</text>`,
    `<text x="${rx1 + 20}" y="${ry1 + 52}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="16" fill="rgb(56,189,248)">${esc(`Inherent Trait: ${trait}`)}</text>`,
  )

  // Stat Token Status Banner
  const tokens = Number(stats.statTokens ?? 0)
  const [tx1, ty1, tx2, ty2] = [60, 998, W - 60, 1115]
  if (tokens > 0) {
    out.push(
      `<rect x="${tx1}" y="${ty1}" width="${tx2 - tx1}" height="${ty2 - ty1}" rx="8" fill="rgb(20,27,45)" stroke="rgb(234,179,8)" stroke-width="2" />`,
      drawHudCornersSvg([tx1, ty1, tx2, ty2], 16, [251, 191, 36], 2),
      `<text x="${tx1 + 24}" y="${ty1 + 30}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="12" fill="rgb(251,191,36)">POIN ATRIBUT TERSEDIA</text>`,
      `<text x="${tx1 + 24}" y="${ty1 + 62}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="22" fill="rgb(248,250,252)">${esc(`UNASSIGNED STAT POINTS: ${tokens}`)}</text>`,
      `<text x="${tx1 + 24}" y="${ty1 + 90}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="400" font-size="13" fill="rgb(203,213,225)">Poin dapat didistribusikan untuk meningkatkan kapasitas tempur karakter.</text>`,
    )
  } else {
    out.push(
      `<rect x="${tx1}" y="${ty1}" width="${tx2 - tx1}" height="${ty2 - ty1}" rx="8" fill="rgb(11,16,28)" stroke="rgb(30,41,59)" stroke-width="1" />`,
      drawHudCornersSvg([tx1, ty1, tx2, ty2], 16, [16, 185, 129], 2),
      `<text x="${tx1 + 24}" y="${ty1 + 30}" font-family="DejaVu Sans Mono, Inter, monospace" font-weight="700" font-size="12" fill="rgb(16,185,129)">STATUS ALOKASI SISTEM</text>`,
      `<text x="${tx1 + 24}" y="${ty1 + 62}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="20" fill="rgb(248,250,252)">DISTRIBUSI ATRIBUT OPTIMAL</text>`,
      `<text x="${tx1 + 24}" y="${ty1 + 90}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="400" font-size="13" fill="rgb(148,163,184)">Seluruh poin atribut telah teralokasikan secara seimbang pada matriks tempur.</text>`,
    )
  }

  out.push(drawFooterSvg('ALLYSSEA SYSTEM · TACTICAL MATRIX VERIFIED'), `</svg>`)
  return out.join('\n')
}

export async function renderStatusCardImage(
  mode: 'character' | 'stats',
  payload: StatusCardPayload,
  logger?: { warn: (obj: unknown, msg: string) => void },
): Promise<Buffer | null> {
  try {
    const svg = mode === 'character' ? buildCharacterCardSvg(payload) : buildStatsCardSvg(payload)
    const fontFiles = resolveFontFiles()
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'original' },
      font: {
        fontFiles,
        loadSystemFonts: true,
        defaultFontFamily: 'Inter',
      },
    })
    return resvg.render().asPng()
  } catch (error) {
    logger?.warn({ error, mode }, 'failed to generate status card image in native TypeScript')
    return null
  }
}
