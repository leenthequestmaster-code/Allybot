# AI Command Architecture Brief

## Problem and outcome

Allybot sudah memiliki helper `chatGroq(message)`, tetapi belum memiliki entry point WhatsApp untuk menggunakannya. Perubahan ini menambahkan satu command canonical `!ask` dengan alias `!ai`, sehingga keduanya mengirim prompt satu kali ke helper dan mengembalikan jawaban bounded ke chat yang sama.

## Scope and non-goals

Scope mencakup plugin command, konfigurasi feature flag, validasi input, timeout/retry boundary, safe error fallback, regression tests, generated `dist`, dan deployment artifact sanitized. Perubahan ini tidak membuat memory percakapan, tidak menyimpan prompt atau jawaban, tidak menambahkan tools/function calling, tidak menambahkan eval/exec/shell, dan tidak membuat command developer atau moderation baru.

## Current facts

`CommandRegistry` memecah body command menjadi token dan whitespace-separated `args`, lalu mengirim balasan melalui `WhatsAppPort.sendText`. Middleware cooldown sudah berlaku per canonical command dan actor. Validator middleware hanya menghentikan handler tanpa mengirim pesan, sehingga feedback input kosong harus dilakukan oleh handler. Helper Groq membaca `GROQ_API_KEY`, memiliki identity boundary, dan menggunakan batas output 100 token.

## Decision

Gunakan plugin modular kecil `src/framework/plugins/ai.ts` yang mendaftarkan `ask` dengan alias `ai`, kategori `ai`, dan cooldown 15 detik. Plugin hanya aktif secara fungsional jika `AI_COMMANDS_ENABLED=true`; default konfigurasi adalah `false`. Saat flag mati, command membalas bahwa fitur belum diaktifkan dan tidak memanggil provider. Saat input kosong, command membalas usage. Prompt dibatasi 1.200 karakter setelah trim. Request provider menggunakan timeout 15 detik dan `maxRetries: 0` melalui opsi kompatibel pada helper; command menangkap kegagalan dan hanya mencatat nama error serta panjang prompt, bukan raw error, prompt, JID, atau jawaban.

## Data flow and trust boundary

WhatsApp message text → command dispatcher → prompt normalization/length check → `chatGroq` → Groq API melalui server-side API key → identity-filtered text → `sendText` ke `remoteJid`. Prompt adalah untrusted input dan tidak pernah diperlakukan sebagai instruksi runtime. Tidak ada persistence atau cross-message context.

## Alternatives rejected

Mendaftarkan command langsung di `technical.ts` akan mencampurkan command AI dengan technical pack dan memperbesar boundary perubahan. Membuat service/database conversation memory tidak dibutuhkan untuk one-shot ask dan menambah risiko privasi. Menggunakan `Promise.race` tanpa timeout SDK akan meninggalkan request provider yang masih berjalan setelah user-facing timeout, sehingga opsi timeout resmi SDK dipilih.

## Failure and security policy

API key kosong, provider error, timeout, rate limit, dan empty provider response menghasilkan fallback teks yang sama-sama non-sensitif. Error log hanya menggunakan `errorName` dan `promptLength`. Output tetap melalui sanitizer helper dan dipotong ke batas reply Allybot. Feature flag default-off mencegah command provider aktif secara tidak sengaja pada environment yang belum dikonfigurasi.

## Rollout and rollback

Source dan generated `dist` diuji lokal dan CI, lalu dikirim melalui artifact sanitized yang hanya berisi `dist`, `package.json`, dan `package-lock.json`. `AI_COMMANDS_ENABLED=true` dapat diaktifkan di Panel tanpa mengubah Startup Command; rollback feature cukup mengubah flag menjadi `false`, sedangkan rollback kode mengikuti artifact commit sebelumnya. API key tidak pernah masuk repository, artifact, atau chat.

## Acceptance criteria

`!ask pertanyaan` dan `!ai pertanyaan` terdaftar ketika feature enabled, menghasilkan satu reply dari helper, tidak memanggil helper ketika disabled atau input kosong, menolak prompt >1.200 karakter, tidak membocorkan raw error, dan tidak merusak command lain. Typecheck, clean build, platform parity, seluruh regression suite, CI, dan smoke test Panel harus lulus.

## References

- [1] [Groq TypeScript SDK README — timeout and retries](https://github.com/groq/groq-typescript)
- [2] [Groq API Reference — Chat Completions](https://console.groq.com/docs/api-reference)
