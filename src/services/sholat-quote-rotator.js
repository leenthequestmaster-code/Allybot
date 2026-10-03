import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
let quotesPool = [];
const HISTORY_FILE = join(process.cwd(), 'data', 'sholat_quote_history.json');
const QUOTES_FILE = join(process.cwd(), 'data', 'sholat_quotes.json');
// Map: groupJid -> array of used quote indexes
let history = {};
let isLoaded = false;
let writeTimeout = null;
async function load() {
    if (isLoaded)
        return;
    // Load pool
    try {
        const data = await fs.readFile(QUOTES_FILE, 'utf-8');
        quotesPool = JSON.parse(data);
    }
    catch (e) {
        quotesPool = []; // fallback
    }
    // Load history
    try {
        if (existsSync(HISTORY_FILE)) {
            const data = await fs.readFile(HISTORY_FILE, 'utf-8');
            history = JSON.parse(data);
        }
    }
    catch (e) {
        history = {};
    }
    isLoaded = true;
}
function scheduleWrite() {
    if (writeTimeout)
        return;
    writeTimeout = setTimeout(async () => {
        writeTimeout = null;
        try {
            await fs.writeFile(HISTORY_FILE, JSON.stringify(history), 'utf-8');
        }
        catch (e) {
            // Best effort
        }
    }, 1000);
}
export async function getQuoteFor(groupJid) {
    await load();
    if (quotesPool.length === 0)
        return null;
    if (!history[groupJid]) {
        history[groupJid] = [];
    }
    const used = history[groupJid];
    // 7 hari = 7 * 5 sholat = 35 quote. Kita simpan 35 history terakhir
    const HISTORY_LIMIT = Math.min(35, Math.max(0, quotesPool.length - 5));
    let availableIdx = [];
    for (let i = 0; i < quotesPool.length; i++) {
        if (!used.includes(i)) {
            availableIdx.push(i);
        }
    }
    // Kalau semua udah dipake (seharusnya nggak mungkin kalau limit dijaga), reset
    if (availableIdx.length === 0) {
        used.length = 0;
        availableIdx = Array.from({ length: quotesPool.length }, (_, i) => i);
    }
    const randomIdx = availableIdx[Math.floor(Math.random() * availableIdx.length)];
    used.push(randomIdx);
    // Jaga limit history
    while (used.length > HISTORY_LIMIT) {
        used.shift(); // Buang yang paling lama
    }
    scheduleWrite();
    return quotesPool[randomIdx];
}
