import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import type { WhatsAppPort } from '../framework/contracts.js'
import { listAll } from './sholat-subs.js'
import { getJadwal } from './sholat-api.js'
import { getQuoteFor } from './sholat-quote-rotator.js'

let intervalId: NodeJS.Timeout | null = null

function getWibDate(): Date {
  const d = new Date()
  // Convert current system time to WIB offset (+7)
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000)
  return new Date(utc + (3600000 * 7))
}

function parseTime(timeStr: string): { h: number; m: number } | null {
  const [h, m] = timeStr.split(':')
  if (!h || !m) return null
  return { h: parseInt(h, 10), m: parseInt(m, 10) }
}

export function startScheduler(whatsapp: WhatsAppPort): void {
  if (intervalId) clearInterval(intervalId)
  
  // Run every 60 seconds
  intervalId = setInterval(async () => {
    try {
      const wib = getWibDate()
      const currentH = wib.getHours()
      const currentM = wib.getMinutes()

      const subs = await listAll()
      const pendingGroups: Array<{ jid: string; sholat: string; kota: string; timeStr: string }> = []

      for (const [groupJid, sub] of Object.entries(subs)) {
        if (!sub.enabled) continue

        let jadwal
        try {
          jadwal = await getJadwal(sub.kota, wib)
        } catch {
          continue // skip if failed to fetch jadwal
        }

        const times = [
          { name: 'Subuh', time: jadwal.subuh },
          { name: 'Dzuhur', time: jadwal.dzuhur },
          { name: 'Ashar', time: jadwal.ashar },
          { name: 'Maghrib', time: jadwal.maghrib },
          { name: 'Isya', time: jadwal.isya }
        ]

        for (const t of times) {
          const parsed = parseTime(t.time)
          if (!parsed) continue
          
          // Hitung selisih menit
          const diffMinutes = (currentH * 60 + currentM) - (parsed.h * 60 + parsed.m)
          
          // Waktu sekarang sama persis dengan jadwal sholat (atau lewat maksimal 5 menit untuk catch-up)
          if (diffMinutes >= 0 && diffMinutes <= 5) {
            // Kita perlu memastikan pesan ini belum dikirim hari ini untuk sholat ini.
            // Biar gampang, kita gunakan Redis/in-memory set. 
            // Karena tidak boleh modif file infra, pakai in-memory `Set`.
            const cacheKey = `${groupJid}_${wib.getFullYear()}${wib.getMonth()}${wib.getDate()}_${t.name}`
            if (!SENT_CACHE.has(cacheKey)) {
               pendingGroups.push({ jid: groupJid, sholat: t.name, kota: sub.kota, timeStr: t.time })
               SENT_CACHE.add(cacheKey)
            }
          }
        }
      }

      // Process pending groups with throttle (minimal 3 detik antar pesan, max 10/menit)
      let sentCount = 0
      for (const task of pendingGroups) {
        if (sentCount >= 10) break // limit 10 per menit
        
        await sendReminder(whatsapp, task.jid, task.sholat, task.kota, task.timeStr)
        sentCount++
        
        if (sentCount < pendingGroups.length && sentCount < 10) {
          await new Promise(r => setTimeout(r, 3000)) // Throttle 3s
        }
      }

      // Bersihkan cache yang udah beda hari (opsional, tapi biar memory nggak bocor)
      if (currentH === 0 && currentM === 0) {
         SENT_CACHE.clear()
      }

    } catch (e) {
      console.error('[sholat-scheduler] Error:', e)
    }
  }, 60000)
}

const SENT_CACHE = new Set<string>()

export async function sendReminder(whatsapp: WhatsAppPort, groupJid: string, sholat: string, kota: string, timeStr: string) {
  try {
    const audioPath = join(process.cwd(), 'data', 'adzan', `${sholat.toLowerCase()}.mp3`)
    let fileData: Buffer | null = null
    try {
      fileData = await fs.readFile(audioPath)
    } catch {
      // Audio missing, we'll just send text
    }

    const quote = await getQuoteFor(groupJid)
    
    const textMsg = `🕌 *Waktu ${sholat} — ${kota.toUpperCase()}*\n⏰ ${timeStr} WIB\n\n` +
      (quote ? `_"${quote.teks}"_\n📚 ${quote.sumber}` : '')

    // Send audio first if exists
    if (fileData && whatsapp.sendMedia) {
      await whatsapp.sendMedia(groupJid, {
        kind: 'audio',
        data: new Uint8Array(fileData),
        mimeType: 'audio/mpeg'
      })
    }
    
    // Then send the text caption
    if (whatsapp.sendText) {
      await whatsapp.sendText(groupJid, textMsg)
    }
    
  } catch (e) {
    console.error(`[sholat-scheduler] Failed sending to ${groupJid}`, e)
  }
}
