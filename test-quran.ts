import { getAyat } from './src/services/quran-api.js'

async function run() {
  try {
    const res = await getAyat(2, 255)
    console.log('Success:', res.surah_name, res.nomor_ayat, res.arab.substring(0, 10))
  } catch (e) {
    console.error(e)
  }
}
run()
