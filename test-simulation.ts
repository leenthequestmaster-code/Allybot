import { quranPlugin } from './src/framework/plugins/quran.js'
import { sholatPlugin } from './src/framework/plugins/sholat.js'
import { doaPlugin } from './src/framework/plugins/doa.js'

async function run() {
  const mockConfig = { botOwnerJid: '123456@s.whatsapp.net' }
  const mockWhatsapp = {
    getGroupMetadata: async (jid: string) => ({
      jid,
      subject: 'Test Group',
      participants: [{ jid: '123456@s.whatsapp.net', role: 'admin' }]
    }),
    sendMedia: async (jid: string, payload: any) => {
      console.log(`\n🤖 BOT (Media Message to ${jid}):\n[Audio Adzan File: ${payload.data.length} bytes, type: ${payload.mimeType}]`)
    },
    sendText: async (jid: string, text: string) => {
      console.log(`\n🤖 BOT (Text Message to ${jid}):\n${text}`)
    }
  }

  const createCtx = (args: string[]) => ({
    args,
    message: { remoteJid: '9999@g.us', senderJid: '123456@s.whatsapp.net' },
    config: mockConfig,
    whatsapp: mockWhatsapp,
    reply: async (msg: string) => {
      console.log(`\n🤖 BOT:\n${msg}`)
    }
  } as any)

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  let quranHandler: any;
  (quranPlugin as any).load({ commands: { register: (cmd: any) => { quranHandler = cmd.handler } } })
  
  let sholatHandler: any;
  (sholatPlugin as any).load({ commands: { register: (cmd: any) => { sholatHandler = cmd.handler } } })

  let doaHandler: any;
  (doaPlugin as any).load({ commands: { register: (cmd: any) => { doaHandler = cmd.handler } } })

  console.log("--------------------------------------------------")
  console.log("👤 ALICIA: !quran 2:255")
  await quranHandler(createCtx(['2:255']))
  await sleep(1000)

  console.log("--------------------------------------------------")
  console.log("👤 ALICIA: !sholat jakarta")
  await sholatHandler(createCtx(['jakarta']))
  await sleep(1000)

  console.log("--------------------------------------------------")
  console.log("👤 ALICIA: !doa tidur")
  await doaHandler(createCtx(['tidur']))
  await sleep(1000)
  
  console.log("--------------------------------------------------")
  console.log("👤 CYRUS (Admin): !sholat subscribe jakarta")
  await sholatHandler(createCtx(['subscribe', 'jakarta']))
  await sleep(1000)

  console.log("--------------------------------------------------")
  console.log("👤 ALICIA: !sholat status")
  await sholatHandler(createCtx(['status']))
  await sleep(1000)

  console.log("--------------------------------------------------")
  console.log("🕒 (Waktu berjalan... Jam menunjukkan pukul 11:45 WIB)")
  console.log("🤖 SYSTEM: Menjalankan Scheduler (Waktu Dzuhur)")
  const { sendReminder } = await import('./src/services/sholat-scheduler.js')
  await sendReminder(mockWhatsapp as any, '9999@g.us', 'Dzuhur', 'jakarta', '11:45')
  console.log("--------------------------------------------------")
}

run().catch(console.error)
