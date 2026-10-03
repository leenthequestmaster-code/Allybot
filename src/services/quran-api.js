const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 jam
async function fetchWithRetry(module, url, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        const start = Date.now();
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000); // 10s
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            const dur = Date.now() - start;
            if (!res.ok) {
                console.error(`[${module}] GET ${url} status=${res.status} dur=${dur}ms (retry ${i})`);
                throw new Error(`HTTP ${res.status}`);
            }
            console.info(`[${module}] GET ${url} status=${res.status} dur=${dur}ms`);
            return await res.json();
        }
        catch (e) {
            lastErr = e;
            const dur = Date.now() - start;
            console.error(`[${module}] GET ${url} status=ERROR dur=${dur}ms msg="${e.message}" (retry ${i})`);
            if (i < retries - 1) {
                await new Promise((r) => setTimeout(r, Math.pow(3, i) * 1000)); // 1s, 3s, 9s backoff
            }
        }
    }
    throw lastErr;
}
export async function getAyat(surah, ayat) {
    if (surah < 1 || surah > 114) {
        throw new Error('Surah nggak valid. Quran cuma punya 114 surah.');
    }
    const now = Date.now();
    let surahData = CACHE.get(surah);
    if (!surahData || surahData.expiresAt < now) {
        try {
            const response = await fetchWithRetry('quran-api', `https://equran.id/api/v2/surat/${surah}`);
            if (response.code !== 200 || !response.data) {
                throw new Error('API return invalid');
            }
            surahData = {
                data: response.data,
                expiresAt: now + CACHE_TTL,
            };
            CACHE.set(surah, surahData);
        }
        catch (e) {
            throw new Error('Server lagi sibuk, coba bentar lagi ya.');
        }
    }
    const { namaLatin, jumlahAyat, ayat: daftarAyat } = surahData.data;
    if (ayat < 1 || ayat > jumlahAyat) {
        throw new Error(`Ayat nggak valid. Surah ${namaLatin} cuma punya ${jumlahAyat} ayat.`);
    }
    const ayatData = daftarAyat[ayat - 1];
    return {
        arab: ayatData.teksArab,
        latin: ayatData.teksLatin,
        arti: ayatData.teksIndonesia,
        surah_name: namaLatin,
        nomor_ayat: ayatData.nomorAyat,
        total_ayat: jumlahAyat,
    };
}
