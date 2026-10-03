import { getJadwal } from '../../services/sholat-api.js';
import { subscribe, unsubscribe, setKota, getStatus } from '../../services/sholat-subs.js';
function isOwner(ctx) {
    if (!ctx.message.senderJid || !ctx.config.botOwnerJid)
        return false;
    return ctx.message.senderJid.split('@')[0] === ctx.config.botOwnerJid.split('@')[0];
}
async function isAdminOrOwner(ctx, groupJid) {
    if (isOwner(ctx))
        return true;
    try {
        const metadata = await ctx.whatsapp.getGroupMetadata(groupJid);
        const sender = ctx.message.senderJid;
        const participant = metadata.participants.find((p) => p.jid === sender);
        return participant?.role === 'admin' || participant?.role === 'superadmin';
    }
    catch (e) {
        return false;
    }
}
export const sholatPlugin = {
    name: 'sholat',
    version: '1.1.0',
    load: (context) => {
        context.commands.register({
            name: 'sholat',
            description: 'Cek jadwal sholat hari ini atau kelola reminder grup',
            category: 'utility',
            handler: async (ctx) => {
                const argsLower = ctx.args.map(a => a.toLowerCase());
                const subcmd = argsLower[0];
                // --- 1. STATUS ---
                if (subcmd === 'status') {
                    if (!ctx.message.remoteJid.endsWith('@g.us')) {
                        await ctx.reply('Sori, command ini khusus dipake di grup aja.');
                        return;
                    }
                    const status = await getStatus(ctx.message.remoteJid);
                    if (!status) {
                        await ctx.reply('Grup ini belum ngaktifin reminder sholat.');
                        return;
                    }
                    const message = [
                        '𓏼 *`𝐒𝘁𝗮𝘁𝘂𝘀 𝐑𝗲𝗺𝗶𝗻𝗱𝗲𝗿`*',
                        '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
                        `⡇╌ *Kota*   : ${status.kota.toUpperCase()}`,
                        `⡇╌ *Status* : ${status.enabled ? 'Aktif' : 'Nonaktif'}`,
                        '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
                        '_Adzan otomatis nyala di grup ini._',
                        '━━━━━━━━━━━━━━━━━━━━',
                        '*© Allyssea Roleplay Community*',
                    ].join('\n');
                    await ctx.reply(message);
                    return;
                }
                // --- 2. SUBSCRIBE ---
                if (subcmd === 'subscribe') {
                    const groupJid = ctx.message.remoteJid;
                    if (!groupJid.endsWith('@g.us')) {
                        await ctx.reply('Subscribe cuma buat di grup, bukan DM.');
                        return;
                    }
                    if (!(await isAdminOrOwner(ctx, groupJid))) {
                        await ctx.reply('Cuma admin grup yang punya akses buat nyalain reminder ini.');
                        return;
                    }
                    const kota = argsLower.slice(1).join(' ');
                    if (!kota) {
                        await ctx.reply('Sertakan nama kotanya ya. Contoh: `!sholat subscribe jakarta`');
                        return;
                    }
                    // Validasi kota dengan mencoba fetch jadwal (melempar error jika invalid)
                    try {
                        await getJadwal(kota);
                    }
                    catch (e) {
                        await ctx.reply(e.message || 'Gagal ngecek kota.');
                        return;
                    }
                    await subscribe(groupJid, kota, ctx.message.senderJid || '');
                    await ctx.reply(`✅ Reminder sholat aktif buat grup ini.\n📍 Kota: ${kota.toUpperCase()}\n\nAdzan & quote bakal dikirim tiap masuk waktu sholat.\nMatiinnya pakai: \`!sholat unsubscribe\` (khusus admin)`);
                    return;
                }
                // --- 3. SET-KOTA ---
                if (subcmd === 'set-kota') {
                    const groupJid = ctx.message.remoteJid;
                    if (!groupJid.endsWith('@g.us')) {
                        await ctx.reply('Sori, command ini khusus dipake di grup aja.');
                        return;
                    }
                    if (!(await isAdminOrOwner(ctx, groupJid))) {
                        await ctx.reply('Cuma admin grup yang bisa ganti kota.');
                        return;
                    }
                    const kota = argsLower.slice(1).join(' ');
                    if (!kota) {
                        await ctx.reply('Sertakan nama kotanya. Contoh: `!sholat set-kota jakarta`');
                        return;
                    }
                    try {
                        await getJadwal(kota); // Validate
                        await setKota(groupJid, kota);
                        await ctx.reply(`✅ Kota reminder sholat udah diganti ke: ${kota.toUpperCase()}`);
                    }
                    catch (e) {
                        await ctx.reply(e.message || 'Gagal ngecek kota.');
                    }
                    return;
                }
                // --- 4. UNSUBSCRIBE ---
                if (subcmd === 'unsubscribe') {
                    const groupJid = ctx.message.remoteJid;
                    if (!groupJid.endsWith('@g.us')) {
                        await ctx.reply('Sori, command ini khusus dipake di grup aja.');
                        return;
                    }
                    if (!(await isAdminOrOwner(ctx, groupJid))) {
                        await ctx.reply('Cuma admin grup yang bisa matiin reminder.');
                        return;
                    }
                    await unsubscribe(groupJid);
                    await ctx.reply('❎ Reminder sholat buat grup ini udah dimatikan.');
                    return;
                }
                // --- 5. RESET (OWNER ONLY) ---
                if (subcmd === 'reset') {
                    if (!isOwner(ctx)) {
                        await ctx.reply('Cuma owner yang bisa reset reminder grup.');
                        return;
                    }
                    const targetJid = ctx.args[1];
                    if (!targetJid) {
                        await ctx.reply('Kasih JID grupnya. Contoh: `!sholat reset 123456@g.us`');
                        return;
                    }
                    await unsubscribe(targetJid);
                    await ctx.reply(`✅ Reminder sholat grup ${targetJid} sukses di-reset.`);
                    return;
                }
                // --- DEFAULT: INFO JADWAL ---
                const query = ctx.args.join(' ').trim();
                if (!query) {
                    await ctx.reply('Kasih nama kotanya ya. Contoh: `!sholat jakarta`');
                    return;
                }
                try {
                    const jadwal = await getJadwal(query);
                    const now = new Date();
                    const tgl = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                    const message = [
                        '𓏼 *`𝐉𝗮𝗱𝘄𝗮𝗹 𝐒𝗵𝗼𝗹𝗮𝘁`*',
                        '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
                        `⡇╌ *Kota* : ${query.toUpperCase()}`,
                        `⡇╌ *Hari* : ${tgl}`,
                        '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
                        `⡇╌ *Imsak*   : ${jadwal.imsak}`,
                        `⡇╌ *Subuh*   : ${jadwal.subuh}`,
                        `⡇╌ *Dzuhur*  : ${jadwal.dzuhur}`,
                        `⡇╌ *Ashar*   : ${jadwal.ashar}`,
                        `⡇╌ *Maghrib* : ${jadwal.maghrib}`,
                        `⡇╌ *Isya*    : ${jadwal.isya}`,
                        '━━━━━━━━━━━━━━━━━━━━',
                        '*© Allyssea Roleplay Community*',
                    ].join('\n');
                    await ctx.reply(message);
                }
                catch (err) {
                    await ctx.reply(err.message || 'Waduh, servernya lagi penuh nih. Coba tes bentar lagi ya.');
                }
            },
        });
    },
};
