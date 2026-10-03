import { getCached, setCached } from './sholat-cache.js';
async function fetchWithRetry(url, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000); // 10s
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        }
        catch (e) {
            lastErr = e;
            if (i < retries - 1) {
                await new Promise((r) => setTimeout(r, Math.pow(3, i) * 1000)); // 1s, 3s, 9s
            }
        }
    }
    throw lastErr;
}
/**
 * Mendapatkan ID kota dari myquran
 */
async function getKotaIdMyQuran(kota) {
    const url = `https://api.myquran.com/v2/sholat/kota/cari/${encodeURIComponent(kota)}`;
    const result = await fetchWithRetry(url);
    if (!result.status || !result.data || result.data.length === 0) {
        throw new Error('Kota tidak ditemukan.');
    }
    return result.data[0].id;
}
/**
 * Helper mendapatkan format YYYY/MM/DD
 */
function getFormatTanggalMyQuran(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
}
/**
 * Helper mendapatkan format DD-MM-YYYY untuk aladhan
 */
function getFormatTanggalAladhan(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${d}-${m}-${y}`;
}
export async function getJadwal(kota, dateObj = new Date()) {
    // Format tanggal universal untuk cache key (YYYY-MM-DD)
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    const dateKey = `${y}-${m}-${d}`;
    // Cek cache
    const cached = await getCached(kota, dateKey);
    if (cached)
        return cached;
    let jadwal = null;
    let lastError = null;
    // 1. Primary: myquran
    try {
        const kotaId = await getKotaIdMyQuran(kota);
        const dateMyQuran = getFormatTanggalMyQuran(dateObj);
        const url = `https://api.myquran.com/v2/sholat/jadwal/${kotaId}/${dateMyQuran}`;
        const result = await fetchWithRetry(url);
        if (result.status && result.data && result.data.jadwal) {
            const j = result.data.jadwal;
            jadwal = {
                imsak: j.imsak,
                subuh: j.subuh,
                dzuhur: j.dzuhur,
                ashar: j.ashar,
                maghrib: j.maghrib,
                isya: j.isya,
            };
        }
        else {
            throw new Error('Invalid response dari myquran');
        }
    }
    catch (e) {
        lastError = e;
    }
    // 2. Fallback: aladhan
    if (!jadwal) {
        try {
            const dateAladhan = getFormatTanggalAladhan(dateObj);
            const url = `https://api.aladhan.com/v1/timingsByCity/${dateAladhan}?city=${encodeURIComponent(kota)}&country=Indonesia`;
            const result = await fetchWithRetry(url);
            if (result.code === 200 && result.data && result.data.timings) {
                const j = result.data.timings;
                jadwal = {
                    imsak: j.Imsak,
                    subuh: j.Fajr,
                    dzuhur: j.Dhuhr,
                    ashar: j.Asr,
                    maghrib: j.Maghrib,
                    isya: j.Isha,
                };
            }
            else {
                throw new Error('Invalid response dari aladhan');
            }
        }
        catch (e) {
            if (e.message?.includes('HTTP 400')) {
                throw new Error(`Kota "${kota}" tidak ditemukan. Coba: Jakarta, Bandung, Surabaya.`);
            }
            throw new Error('Service sedang sibuk, coba lagi nanti.');
        }
    }
    if (jadwal) {
        await setCached(kota, dateKey, jadwal);
        return jadwal;
    }
    if (lastError?.message.includes('Kota tidak ditemukan')) {
        throw new Error(`Kota "${kota}" tidak ditemukan. Coba: Jakarta, Bandung, Surabaya.`);
    }
    throw new Error('Service sedang sibuk, coba lagi nanti.');
}
