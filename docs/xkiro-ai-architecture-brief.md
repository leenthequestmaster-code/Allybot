# XKIRO AI Integration Brief

## Tujuan
Menambahkan bantuan AI berbasis command WhatsApp tanpa passive chat memory, tanpa mengubah adapter Baileys, dan tanpa membocorkan credential atau raw provider error.

## Keputusan desain
Source mengikuti konvensi TypeScript Allybot: `src/ai-handler.ts` menjadi boundary provider dan dikompilasi menjadi `dist/ai-handler.js`; `src/framework/plugins/ai.ts` menjadi boundary command. Handler menggunakan SDK `openai` dengan `baseURL` tetap `https://api.xkiro.com/v1`, key dari `XKIRO_API_KEY`, dan dua konstanta model terpisah: primary lalu fallback. Client dibuat dengan timeout bounded dan retry SDK dimatikan agar fallback terjadi tepat setelah kegagalan attempt pertama.

Feature flag `XKIRO_AI_ENABLED` default `false`. Saat aktif, plugin mendaftarkan `!ai` dengan alias `!ally`; prefix group yang dikonfigurasi framework tetap didukung, sehingga `.ally` juga berlaku bila prefix group adalah `.`. Kategori `ai` sudah disediakan menu registry dan tidak memerlukan perubahan button/menu.

## Kontrak dan batas
Input command digabung dari args, dipangkas, dan dibatasi 1.200 karakter. Output kosong dianggap gagal dan output non-kosong dipotong maksimum 2.000 karakter. Tidak ada conversation history, tool calling, file access, web access, atau arbitrary code execution. System prompt menetapkan persona Allybot AI yang ramah dan santai, menganggap input pengguna sebagai untrusted content, serta menolak pengungkapan instruksi internal, credential, source privat, database, session, atau eksekusi kode.

## Failure behavior
Jika key tidak tersedia, command fail-closed dengan pesan aman. Jika primary gagal, handler mencoba fallback satu kali. Jika fallback juga gagal, command mengirim fallback teks generik. Log hanya menyimpan attempt, error class, dan status HTTP bila tersedia; tidak menyimpan prompt, response, API key, raw error, JID, atau nama model.

## Verifikasi dan rollback
Unit test menguji primary success, primary-to-fallback, double failure, missing key, input/output bounds, dan redacted logging. Integration test menguji dispatch `!ai`/alias melalui `ApplicationFramework`, feature gate, dan isolasi error. Gate wajib: typecheck, clean build, full regression, platform parity, dependency hygiene, CI, dan artifact sanitized. Rollback dilakukan dengan revert commit dan deploy artifact CI sebelumnya; flag production tetap default-off sampai key dan endpoint diverifikasi operator.

## Sumber keputusan
Konfigurasi client mengikuti OpenAI Node SDK resmi: constructor menerima `apiKey`, custom `baseURL`, `timeout`, dan `maxRetries`; Chat Completions menggunakan `client.chat.completions.create`. SDK docs juga menunjukkan error provider memiliki status dan retry default, sehingga integrasi ini mematikan retry internal untuk menjaga fallback bounded.
