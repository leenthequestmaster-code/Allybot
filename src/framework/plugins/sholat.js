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
                        await ctx.reply('Perintah ini hanya dapat digunakan di grup.');
                        return;
                    }
                    const status = await getStatus(ctx.message.remoteJid);
                    if (!status) {
                        await ctx.reply('Grup ini belum subscribe reminder sholat.');
                        return;
                    }
                    await ctx.reply(`✅ *Reminder Sholat Aktif*\nKota: ${status.kota.toUpperCase()}\nStatus: ${status.enabled ? 'On' : 'Off'}`);
                    return;
                }
                // --- 2. SUBSCRIBE ---
                if (subcmd === 'subscribe') {
                    const groupJid = ctx.message.remoteJid;
                    if (!groupJid.endsWith('@g.us')) {
                        await ctx.reply('Subscribe hanya untuk grup, bukan DM.');
                        return;
                    }
                    if (!(await isAdminOrOwner(ctx, groupJid))) {
                        await ctx.reply('Hanya admin grup yang bisa subscribe reminder.');
                        return;
                    }
                    const kota = argsLower.slice(1).join(' ');
                    if (!kota) {
                        await ctx.reply('Wajib sertakan kota. Contoh: !sholat subscribe jakarta');
                        return;
                    }
                    // Validasi kota dengan mencoba fetch jadwal (melempar error jika invalid)
                    try {
                        await getJadwal(kota);
                    }
                    catch (e) {
                        await ctx.reply(e.message || 'Gagal memvalidasi kota.');
                        return;
                    }
                    await subscribe(groupJid, kota, ctx.message.senderJid || '');
                    await ctx.reply(`✅ Reminder sholat aktif untuk grup ini.\nKota: ${kota.toUpperCase()}\n\nAkan kirim adzan + quote tiap waktu sholat.\nAdmin bisa nonaktifkan dengan: !sholat unsubscribe`);
                    return;
                }
                // --- 3. SET-KOTA ---
                if (subcmd === 'set-kota') {
                    const groupJid = ctx.message.remoteJid;
                    if (!groupJid.endsWith('@g.us')) {
                        await ctx.reply('Perintah ini hanya untuk grup.');
                        return;
                    }
                    if (!(await isAdminOrOwner(ctx, groupJid))) {
                        await ctx.reply('Hanya admin grup yang bisa mengganti kota.');
                        return;
                    }
                    const kota = argsLower.slice(1).join(' ');
                    if (!kota) {
                        await ctx.reply('Wajib sertakan kota. Contoh: !sholat set-kota jakarta');
                        return;
                    }
                    try {
                        await getJadwal(kota); // Validate
                        await setKota(groupJid, kota);
                        await ctx.reply(`✅ Kota untuk reminder sholat berhasil diubah menjadi: ${kota.toUpperCase()}`);
                    }
                    catch (e) {
                        await ctx.reply(e.message || 'Gagal memvalidasi/mengubah kota.');
                    }
                    return;
                }
                // --- 4. UNSUBSCRIBE ---
                if (subcmd === 'unsubscribe') {
                    const groupJid = ctx.message.remoteJid;
                    if (!groupJid.endsWith('@g.us')) {
                        await ctx.reply('Perintah ini hanya untuk grup.');
                        return;
                    }
                    if (!(await isAdminOrOwner(ctx, groupJid))) {
                        await ctx.reply('Hanya admin grup yang bisa unsubscribe.');
                        return;
                    }
                    await unsubscribe(groupJid);
                    await ctx.reply('❎ Reminder sholat untuk grup ini telah dinonaktifkan.');
                    return;
                }
                // --- 5. RESET (OWNER ONLY) ---
                if (subcmd === 'reset') {
                    if (!isOwner(ctx)) {
                        await ctx.reply('Hanya owner yang bisa mereset reminder grup.');
                        return;
                    }
                    const targetJid = ctx.args[1];
                    if (!targetJid) {
                        await ctx.reply('Sertakan JID grup. Contoh: !sholat reset 123456@g.us');
                        return;
                    }
                    await unsubscribe(targetJid);
                    await ctx.reply(`✅ Reminder sholat untuk grup ${targetJid} berhasil di-reset.`);
                    return;
                }
                // --- DEFAULT: INFO JADWAL ---
                const query = ctx.args.join(' ').trim();
                if (!query) {
                    await ctx.reply('Ketik kota. Contoh: !sholat jakarta');
                    return;
                }
                try {
                    const jadwal = await getJadwal(query);
                    const now = new Date();
                    const tgl = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                    const message = `🕌 *Jadwal Sholat — ${query.toUpperCase()}*\n📅 ${tgl}\n\n` +
                        `Imsak: ${jadwal.imsak}\n` +
                        `Subuh: ${jadwal.subuh}\n` +
                        `Dzuhur: ${jadwal.dzuhur}\n` +
                        `Ashar: ${jadwal.ashar}\n` +
                        `Maghrib: ${jadwal.maghrib}\n` +
                        `Isya: ${jadwal.isya}`;
                    await ctx.reply(message);
                }
                catch (err) {
                    await ctx.reply(err.message || 'Service sedang sibuk, coba lagi nanti.');
                }
            },
        });
    },
};
