# Semi-button Compatibility Evidence

**Tanggal:** 23 Agustus 2026  
**Scope:** Main menu informative text + native quick-reply navigation pada Baileys pinned `7.0.0-rc14`.

## Observed sources

1. [Meta Interactive reply buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages) menyatakan interactive reply buttons menyediakan sampai tiga predefined replies. Halaman yang dibuka juga mendeskripsikan ID tombol sebagai unique identifier dan batas label tombol sampai 20 karakter.
2. [Baileys documentation](https://baileys.wiki/) mendeskripsikan Baileys sebagai library WebSocket untuk WhatsApp Web API, dengan dukungan pengiriman text, media, polls, dan message capabilities lain. Dokumentasi juga memberi peringatan bahwa Baileys adalah library unofficial dan harus digunakan secara bertanggung jawab; tidak boleh dipakai untuk bulk messaging atau spam.
3. Source lokal `src/platform/buttons.ts` sudah mendefinisikan `NativeQuickReplyPayload` dengan `body`, optional `footer`, dan maksimal tiga native buttons melalui `CapabilityAwareButtonAdapter`.
4. Source lokal `src/whatsapp.ts` sudah membentuk `interactiveMessage`/`nativeFlowMessage` dengan `quick_reply` buttons pada pinned Baileys package, serta `extractButtonId` sudah menerima beberapa bentuk callback yang didukung adapter.

## Decision

Semi-button V2-A memakai payload native yang sudah ada. Main menu body sekarang berisi identitas halaman, daftar seluruh kategori yang terlihat, jumlah command/status, penjelasan bahwa tombol hanya navigasi, dan fallback `!menu <angka>`. Tombol tetap dibatasi oleh existing adapter dan tidak menjadi jalur eksekusi command berparameter.

Submenu tetap text-first karena command membutuhkan contoh, parameter, permission marker, dan subcommand. Location message, `contextInfo` rows, atau format native lain tidak diadopsi dalam V2-A karena tidak diperlukan untuk memenuhi semi-button contract dan belum memiliki synthetic/live evidence yang lebih kuat daripada existing native quick reply transport.

## Local verification

V2-A typecheck, clean build, framework/menu/utility tests, dan full regression lulus setelah body native diperkaya. Native transport contract tests tetap lulus; tidak ada perubahan pada relay node metadata atau parser callback.

## Residual risk

Live WhatsApp/Baileys acceptance masih belum dilakukan pada isolated acceptance account/group. Karena itu bukti ini memvalidasi source contract dan compiled/fake adapter behavior, bukan menjamin semua client WhatsApp menampilkan payload identik.
