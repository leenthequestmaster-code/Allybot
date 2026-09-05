import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MsgBuilder,
  parseRichMarkdown,
  nativeFlowAdditionalNodes,
} from './msg-builder.js'

describe('MsgBuilder & Rich Message Protocols', () => {
  it('parses markdown into AIRich structured parts (code, table, suggest, tip, text)', () => {
    const md = `
Halo semuanya! Ini teks pengantar.

\`\`\`typescript
const greeting = "Hello World";
console.log(greeting);
\`\`\`

:::tip
Pastikan Node.js minimal versi 20.
:::

| Fitur | Status |
|---|---|
| AIRich | Aktif |
| NativeFlow | Aktif |

:::suggest
Menu Utama | Dokumentasi | Bantuan
:::
`
    const parts = parseRichMarkdown(md)
    assert.ok(parts.length >= 5)

    const codePart = parts.find((p) => p.type === 'code')
    assert.ok(codePart)
    assert.equal(codePart?.language, 'typescript')
    assert.ok(codePart?.content.includes('Hello World'))

    const tipPart = parts.find((p) => p.type === 'tip')
    assert.ok(tipPart)
    assert.equal(tipPart?.content, 'Pastikan Node.js minimal versi 20.')

    const tablePart = parts.find((p) => p.type === 'table')
    assert.ok(tablePart)
    assert.equal(tablePart?.rows?.length, 3)

    const suggestPart = parts.find((p) => p.type === 'suggest')
    assert.ok(suggestPart)
    assert.equal(suggestPart?.content, 'Menu Utama | Dokumentasi | Bantuan')
  })

  it('builds standard text payload when no rich or buttons specified', () => {
    const built = MsgBuilder.to('628123456789@s.whatsapp.net')
      .text('Pesan biasa sederhana')
      .build()

    assert.equal(built.kind, 'text')
    if (built.kind === 'text') {
      assert.equal(built.text, 'Pesan biasa sederhana')
      assert.equal(built.mentions, undefined)
    }
  })

  it('builds AIRich payload with submessages conforming to proto.AIRichResponseMessage', () => {
    const md = `
Laporan Audit:
\`\`\`bash
pnpm test
\`\`\`
`
    const built = MsgBuilder.to('628123456789@s.whatsapp.net')
      .text(md, { rich: true })
      .build()

    assert.equal(built.kind, 'airich')
    if (built.kind === 'airich') {
      const invoke = built.payload.botInvokeMessage
      assert.ok(invoke.message?.richResponseMessage)
      const submsgs = invoke.message?.richResponseMessage?.submessages
      assert.ok(Array.isArray(submsgs))
      assert.ok(submsgs.length >= 2)
      assert.ok(built.fallbackText.includes('pnpm test'))
    }
  })

  it('builds Native Flow Interactive payload with multiple button types and fallback text', () => {
    const built = MsgBuilder.to('628123456789@s.whatsapp.net')
      .header('Header Judul', 'Subjudul')
      .text('Pilih aksi berikut:')
      .footer('Footer info')
      .button({ type: 'reply', id: 'btn_confirm', text: 'Konfirmasi' })
      .button({ type: 'url', text: 'Buka Web', url: 'https://example.com' })
      .button({ type: 'copy', text: 'Salin Kode', code: 'PROMO100' })
      .build()

    assert.equal(built.kind, 'interactive')
    if (built.kind === 'interactive') {
      const im = built.payload.interactiveMessage
      assert.equal(im.header?.title, 'Header Judul')
      assert.equal(im.header?.subtitle, 'Subjudul')
      assert.equal(im.body?.text, 'Pilih aksi berikut:')
      assert.equal(im.footer?.text, 'Footer info')

      const buttons = im.nativeFlowMessage?.buttons
      assert.ok(buttons)
      assert.equal(buttons.length, 3)
      assert.equal(buttons[0]?.name, 'quick_reply')
      assert.equal(buttons[1]?.name, 'cta_url')
      assert.equal(buttons[2]?.name, 'cta_copy')

      const fallback = built.fallbackText
      assert.ok(fallback.includes('*Header Judul*'))
      assert.ok(fallback.includes('_Subjudul_'))
      assert.ok(fallback.includes('[1] Konfirmasi'))
      assert.ok(fallback.includes('[🔗 Buka Web] (https://example.com)'))
      assert.ok(fallback.includes('[📋 Salin Kode: PROMO100]'))
      assert.ok(fallback.includes('_Footer info_'))
    }
  })

  it('builds single_select interactive list menu with proper JSON and fallback formatting', () => {
    const built = MsgBuilder.to('628123456789@s.whatsapp.net')
      .text('Silakan pilih salah satu opsi dari menu:')
      .list({
        buttonText: 'Lihat Daftar',
        sections: [
          {
            title: 'Layanan Utama',
            rows: [
              { id: 'srv_1', title: 'Konsultasi', description: 'Diskusi teknis' },
              { id: 'srv_2', title: 'Audit Keamanan' },
            ],
          },
        ],
      })
      .build()

    assert.equal(built.kind, 'interactive')
    if (built.kind === 'interactive') {
      const buttons = built.payload.interactiveMessage.nativeFlowMessage?.buttons
      assert.ok(buttons)
      assert.equal(buttons.length, 1)
      assert.equal(buttons[0]?.name, 'single_select')
      const parsedParams = JSON.parse(buttons[0]?.buttonParamsJson ?? '{}')
      assert.equal(parsedParams.title, 'Lihat Daftar')
      assert.equal(parsedParams.sections[0].rows.length, 2)
      assert.equal(parsedParams.sections[0].rows[0].id, 'srv_1')

      const fallback = built.fallbackText
      assert.ok(fallback.includes('[Lihat Daftar]'))
      assert.ok(fallback.includes('• Konsultasi (srv_1) - Diskusi teknis'))
      assert.ok(fallback.includes('• Audit Keamanan (srv_2)'))
    }
  })

  it('builds carousel cards properly inside interactiveMessage', () => {
    const built = MsgBuilder.to('628123456789@s.whatsapp.net')
      .text('Katalog Produk:')
      .carousel([
        {
          title: 'Produk A',
          body: 'Harga: 100K',
          buttons: [{ type: 'reply', id: 'buy_a', text: 'Beli A' }],
        },
        {
          title: 'Produk B',
          body: 'Harga: 200K',
          buttons: [{ type: 'url', text: 'Detail B', url: 'https://example.com/b' }],
        },
      ])
      .build()

    assert.equal(built.kind, 'interactive')
    if (built.kind === 'interactive') {
      const carousel = built.payload.interactiveMessage.carouselMessage
      assert.ok(carousel)
      assert.equal(carousel.cards?.length, 2)
      assert.equal(carousel.cards[0]?.header?.title, 'Produk A')
      assert.equal(carousel.cards[0]?.body?.text, 'Harga: 100K')
      assert.equal(carousel.cards[1]?.header?.title, 'Produk B')
    }
  })

  it('generates correct nativeFlow additionalNodes for group and private chats', () => {
    const privateNodes = nativeFlowAdditionalNodes('628123456789@s.whatsapp.net')
    assert.equal(privateNodes.length, 2)
    assert.equal(privateNodes[0]?.tag, 'biz')
    assert.equal(privateNodes[1]?.tag, 'bot')

    const groupNodes = nativeFlowAdditionalNodes('1203630123456789@g.us')
    assert.equal(groupNodes.length, 1)
    assert.equal(groupNodes[0]?.tag, 'biz')
  })

  it('carries the mixed native_flow child only when the interactive payload needs it', () => {
    const withMixed = nativeFlowAdditionalNodes('628123456789@s.whatsapp.net')[0]?.content
    assert.ok(Array.isArray(withMixed))
    assert.equal(withMixed[0]?.tag, 'interactive')
    const mixedChildren = withMixed[0]?.content
    assert.ok(Array.isArray(mixedChildren))
    assert.equal(mixedChildren[0]?.tag, 'native_flow')
    assert.equal(mixedChildren[0]?.attrs.name, 'mixed')

    const withoutMixed = nativeFlowAdditionalNodes('628123456789@s.whatsapp.net', false)[0]?.content
    assert.ok(Array.isArray(withoutMixed))
    assert.equal(withoutMixed[0]?.tag, 'interactive')
    assert.equal(withoutMixed[0]?.content, undefined)
  })

  it('enforces validation constraints (max buttons, duplicate list ids, empty text)', () => {
    assert.throws(() => {
      const mb = MsgBuilder.to('jid')
      for (let i = 0; i < 11; i++) {
        mb.button({ type: 'reply', id: `b_${i}`, text: `Btn ${i}` })
      }
    }, /Maximum 10 buttons allowed/)

    assert.throws(() => {
      MsgBuilder.to('jid')
        .list({
          buttonText: 'Pilih',
          sections: [
            {
              title: 'Sec 1',
              rows: [
                { id: 'dup_id', title: 'Row 1' },
                { id: 'dup_id', title: 'Row 2' },
              ],
            },
          ],
        })
    }, /Duplicate list row ID/)
  })

  it('falls back gracefully to sendText if socket is disconnected or error occurs', async () => {
    let sentText = ''
    let sentJid = ''

    const fakeTransport: Parameters<typeof MsgBuilder.prototype.send>[0] = {
      isConnected: false,
      socket: undefined,
      onMessage() { return () => {} },
      onGroupParticipantUpdate() { return () => {} },
      onConnectionState() { return () => {} },
      async sendText(jid: string, text: string) {
        sentJid = jid
        sentText = text
      },
      async getGroupMetadata(groupJid: string) {
        return {
          jid: groupJid,
          subject: 'Test Group',
          participants: [],
        }
      },
      async getGroupInviteLink() { return '' },
      async start() {},
      async close() {},
    }

    await MsgBuilder.to('target@s.whatsapp.net')
      .header('Notifikasi')
      .text('Harap perbarui data Anda.')
      .button({ type: 'reply', id: 'update', text: 'Perbarui' })
      .send(fakeTransport)

    assert.equal(sentJid, 'target@s.whatsapp.net')
    assert.ok(sentText.includes('*Notifikasi*'))
    assert.ok(sentText.includes('Harap perbarui data Anda.'))
    assert.ok(sentText.includes('[1] Perbarui'))
  })
})

type SendTransport = Parameters<typeof MsgBuilder.prototype.send>[0]

interface RelayCall {
  readonly jid: string
  readonly messageKeys: readonly string[]
  readonly nodeTags: readonly string[]
}

function stubTransport(mode: 'relay' | 'throw') {
  const relayCalls: RelayCall[] = []
  const warnings: string[] = []
  const sentTexts: string[] = []

  const socket = {
    user: { id: '628999:1@s.whatsapp.net' },
    logger: {
      warn(_obj: unknown, msg?: string) {
        warnings.push(msg ?? '')
      },
    },
    async relayMessage(
      jid: string,
      message: Record<string, unknown>,
      options: { additionalNodes?: readonly { tag: string }[] },
    ) {
      if (mode === 'throw') throw new Error('relay rejected by server')
      relayCalls.push({
        jid,
        messageKeys: Object.keys(message).filter((key) => message[key] !== null && message[key] !== undefined),
        nodeTags: (options.additionalNodes ?? []).map((node) => node.tag),
      })
    },
  }

  const transport = {
    isConnected: true,
    socket,
    async sendText(_jid: string, text: string) {
      sentTexts.push(text)
    },
  } as unknown as SendTransport

  return { transport, relayCalls, warnings, sentTexts }
}

describe('MsgBuilder regression guards', () => {
  it('renders carousel cards in fallback text instead of an empty body', () => {
    const builder = MsgBuilder.to('628123456789@s.whatsapp.net').carousel([
      {
        title: 'Produk A',
        subtitle: 'Edisi terbatas',
        body: 'Harga: 100K',
        footer: 'Stok 3',
        buttons: [{ type: 'reply', id: 'buy_a', text: 'Beli A' }],
      },
    ])

    const fallback = builder.buildFallbackText()
    assert.notEqual(fallback.trim(), '')
    assert.ok(fallback.includes('*1. Produk A*'))
    assert.ok(fallback.includes('_Edisi terbatas_'))
    assert.ok(fallback.includes('Harga: 100K'))
    assert.ok(fallback.includes('[buy_a] Beli A'))
    assert.ok(fallback.includes('_Stok 3_'))
  })

  it('rejects AIRich combined with interactive components instead of dropping them silently', () => {
    assert.throws(
      () =>
        MsgBuilder.to('628123456789@s.whatsapp.net')
          .text('Laporan siap.', { rich: true })
          .button({ type: 'reply', id: 'confirm', text: 'Konfirmasi' })
          .build(),
      /AIRich mode cannot be combined/,
    )
  })

  it('maps every carousel card button type to its own native flow name', () => {
    const built = MsgBuilder.to('628123456789@s.whatsapp.net')
      .text('Katalog')
      .carousel([
        {
          title: 'Kartu',
          body: 'Isi',
          buttons: [
            { type: 'copy', text: 'Salin', code: 'PROMO100' },
            { type: 'call', text: 'Telepon', phone: '628999' },
            { type: 'url', text: 'Detail', url: 'https://example.com' },
          ],
        },
      ])
      .build()

    assert.equal(built.kind, 'interactive')
    if (built.kind !== 'interactive') return
    const cardButtons = built.payload.interactiveMessage.carouselMessage?.cards?.[0]?.nativeFlowMessage?.buttons
    assert.ok(cardButtons)
    assert.deepEqual(cardButtons.map((b) => b.name), ['cta_copy', 'cta_call', 'cta_url'])
    assert.equal(JSON.parse(cardButtons[0]?.buttonParamsJson ?? '{}').copy_code, 'PROMO100')
    assert.equal(JSON.parse(cardButtons[1]?.buttonParamsJson ?? '{}').phone_number, '628999')
    assert.equal(JSON.parse(cardButtons[2]?.buttonParamsJson ?? '{}').url, 'https://example.com')
  })

  it('omits the bot node for AIRich relays in group chats and keeps it in private chats', async () => {
    const group = stubTransport('relay')
    await MsgBuilder.to('1203630123456789@g.us').text('Isi laporan', { rich: true }).send(group.transport)
    assert.equal(group.relayCalls.length, 1)
    assert.deepEqual(group.relayCalls[0]?.messageKeys, ['botInvokeMessage'])
    assert.deepEqual(group.relayCalls[0]?.nodeTags, ['biz'])

    const direct = stubTransport('relay')
    await MsgBuilder.to('628123456789@s.whatsapp.net').text('Isi laporan', { rich: true }).send(direct.transport)
    assert.deepEqual(direct.relayCalls[0]?.nodeTags, ['biz', 'bot'])
  })

  it('logs a warning before falling back to text when relay throws', async () => {
    const failing = stubTransport('throw')
    await MsgBuilder.to('628123456789@s.whatsapp.net')
      .text('Pilih aksi')
      .button({ type: 'reply', id: 'ack', text: 'Oke' })
      .send(failing.transport)

    assert.equal(failing.warnings.length, 1)
    assert.match(failing.warnings[0] ?? '', /relay failed/)
    assert.equal(failing.sentTexts.length, 1)
    assert.ok(failing.sentTexts[0]?.includes('[1] Oke'))
  })

  it('refuses to build a blank plain-text payload', () => {
    assert.throws(() => MsgBuilder.to('628123456789@s.whatsapp.net').text('   ').build(), /must not be empty/)
  })

  it('rejects duplicate reply button IDs that would make dispatch ambiguous', () => {
    assert.throws(
      () =>
        MsgBuilder.to('628123456789@s.whatsapp.net')
          .text('Pilih')
          .button({ type: 'reply', id: 'same', text: 'A' })
          .button({ type: 'reply', id: 'same', text: 'B' })
          .build(),
      /Duplicate reply button ID: same/,
    )
  })

  it('tags AIRich payloads with the standard response type from the protobuf enum', () => {
    const built = MsgBuilder.to('628123456789@s.whatsapp.net').text('Ringkasan singkat.', { rich: true }).build()
    assert.equal(built.kind, 'airich')
    if (built.kind !== 'airich') return
    assert.equal(built.payload.botInvokeMessage.message?.richResponseMessage?.messageType, 1)
  })
})
