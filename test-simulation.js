import { quranPlugin } from './src/framework/plugins/quran.js';
import { sholatPlugin } from './src/framework/plugins/sholat.js';
import { doaPlugin } from './src/framework/plugins/doa.js';
async function run() {
    const mockConfig = { botOwnerJid: '123456@s.whatsapp.net' };
    const mockWhatsapp = {
        getGroupMetadata: async (jid) => ({
            jid,
            subject: 'Test Group',
            participants: [{ jid: '123456@s.whatsapp.net', role: 'admin' }]
        }),
        sendMedia: async (jid, payload) => {
            console.log(`\n🤖 BOT (Media Message to ${jid}):\n[Audio Adzan File: ${payload.data.length} bytes, type: ${payload.mimeType}]`);
        },
        sendText: async (jid, text) => {
            console.log(`\n🤖 BOT (Text Message to ${jid}):\n${text}`);
        }
    };
    const createCtx = (args) => ({
        args,
        message: { remoteJid: '9999@g.us', senderJid: '123456@s.whatsapp.net' },
        config: mockConfig,
        whatsapp: mockWhatsapp,
        reply: async (msg) => {
            console.log(`\n🤖 BOT:\n${msg}`);
        }
    });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let quranHandler;
    quranPlugin.load({ commands: { register: (cmd) => { quranHandler = cmd.handler; } } });
    let sholatHandler;
    sholatPlugin.load({ commands: { register: (cmd) => { sholatHandler = cmd.handler; } } });
    let doaHandler;
    doaPlugin.load({ commands: { register: (cmd) => { doaHandler = cmd.handler; } } });
    console.log("--------------------------------------------------");
    console.log("👤 ALICIA: !quran 2:255");
    await quranHandler(createCtx(['2:255']));
    await sleep(1000);
    console.log("--------------------------------------------------");
    console.log("👤 ALICIA: !sholat jakarta");
    await sholatHandler(createCtx(['jakarta']));
    await sleep(1000);
    console.log("--------------------------------------------------");
    console.log("👤 ALICIA: !doa tidur");
    await doaHandler(createCtx(['tidur']));
    await sleep(1000);
    console.log("--------------------------------------------------");
    console.log("👤 CYRUS (Admin): !sholat subscribe jakarta");
    await sholatHandler(createCtx(['subscribe', 'jakarta']));
    await sleep(1000);
    console.log("--------------------------------------------------");
    console.log("👤 ALICIA: !sholat status");
    await sholatHandler(createCtx(['status']));
    await sleep(1000);
    console.log("--------------------------------------------------");
    console.log("🕒 (Waktu berjalan... Jam menunjukkan pukul 11:45 WIB)");
    console.log("🤖 SYSTEM: Menjalankan Scheduler (Waktu Dzuhur)");
    const { sendReminder } = await import('./src/services/sholat-scheduler.js');
    await sendReminder(mockWhatsapp, '9999@g.us', 'Dzuhur', 'jakarta', '11:45');
    console.log("--------------------------------------------------");
}
run().catch(console.error);
