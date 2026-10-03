import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
const FILE_PATH = join(process.cwd(), 'data', 'sholat_subs.json');
let STATE = {};
let isLoaded = false;
let writeTimeout = null;
async function loadState() {
    if (isLoaded)
        return;
    if (existsSync(FILE_PATH)) {
        try {
            const data = await fs.readFile(FILE_PATH, 'utf-8');
            STATE = JSON.parse(data);
        }
        catch (e) {
            STATE = {};
        }
    }
    isLoaded = true;
}
function scheduleWrite() {
    if (writeTimeout)
        return;
    writeTimeout = setTimeout(async () => {
        writeTimeout = null;
        try {
            await fs.writeFile(FILE_PATH, JSON.stringify(STATE, null, 2), 'utf-8');
        }
        catch (e) {
            // Best effort persist
        }
    }, 500); // Debounce 500ms
}
export async function subscribe(groupJid, kota, byJid) {
    await loadState();
    STATE[groupJid] = {
        kota: kota.toLowerCase().trim(),
        subscribedAt: Date.now(),
        subscribedBy: byJid,
        enabled: true,
    };
    scheduleWrite();
}
export async function unsubscribe(groupJid) {
    await loadState();
    if (STATE[groupJid]) {
        delete STATE[groupJid];
        scheduleWrite();
    }
}
export async function setKota(groupJid, kota) {
    await loadState();
    if (STATE[groupJid]) {
        STATE[groupJid].kota = kota.toLowerCase().trim();
        scheduleWrite();
    }
    else {
        throw new Error('Grup belum subscribed. Jalankan !sholat subscribe <kota> dulu.');
    }
}
export async function getStatus(groupJid) {
    await loadState();
    return STATE[groupJid] || null;
}
export async function listAll() {
    await loadState();
    return { ...STATE };
}
