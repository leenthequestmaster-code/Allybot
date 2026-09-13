import { randomUUID } from 'node:crypto'
import {
  proto,
  generateMessageIDV2,
  type BinaryNode,
  type WASocket,
} from '@whiskeysockets/baileys'
import { isGroupJid } from './validation.js'
import type { WhatsAppPort } from './contracts.js'

export interface InteractiveReplyButton {
  readonly type?: 'reply'
  readonly id: string
  readonly text: string
}

export interface InteractiveUrlButton {
  readonly type: 'url'
  readonly text: string
  readonly url: string
  readonly webview?: boolean
}

export interface InteractiveCopyButton {
  readonly type: 'copy'
  readonly text: string
  readonly code: string
}

export interface InteractiveCallButton {
  readonly type: 'call'
  readonly text: string
  readonly phone: string
}

export interface InteractiveReminderButton {
  readonly type: 'reminder'
  readonly text: string
  readonly id?: string
}

export interface InteractiveCancelReminderButton {
  readonly type: 'cancel-reminder'
  readonly text: string
  readonly id?: string
}

export interface InteractiveLocationButton {
  readonly type: 'location'
  readonly text?: string
}

export interface InteractiveAddressButton {
  readonly type: 'address'
  readonly text: string
  readonly id?: string
}

export type InteractiveButtonDef =
  | InteractiveReplyButton
  | InteractiveUrlButton
  | InteractiveCopyButton
  | InteractiveCallButton
  | InteractiveReminderButton
  | InteractiveCancelReminderButton
  | InteractiveLocationButton
  | InteractiveAddressButton

export interface ListRowDef {
  readonly id: string
  readonly title: string
  readonly description?: string
}

export interface ListSectionDef {
  readonly title: string
  readonly rows: readonly ListRowDef[]
}

export interface ListOptions {
  readonly buttonText: string
  readonly title?: string
  readonly description?: string
  readonly footerText?: string
  readonly sections: readonly ListSectionDef[]
}

export interface CarouselCardDef {
  readonly title?: string
  readonly subtitle?: string
  readonly body?: string
  readonly footer?: string
  readonly buttons?: readonly InteractiveButtonDef[]
}

export interface AIRichPart {
  readonly type: 'text' | 'code' | 'table' | 'suggest' | 'tip'
  readonly content: string
  readonly language?: string
  readonly rows?: readonly (readonly string[])[]
}

export type BuiltMessagePayload =
  | { readonly kind: 'text'; readonly text: string; readonly mentions?: readonly string[] }
  | {
      readonly kind: 'interactive'
      readonly payload: { readonly interactiveMessage: proto.Message.InteractiveMessage }
      readonly fallbackText: string
    }
  | {
      readonly kind: 'airich'
      readonly payload: { readonly botInvokeMessage: proto.Message.IFutureProofMessage }
      readonly fallbackText: string
    }

export function nativeFlowAdditionalNodes(remoteJid: string, includeMixedFlow = true): BinaryNode[] {
  const nodes: BinaryNode[] = [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: includeMixedFlow ? [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] : undefined,
        },
      ],
    },
  ]

  if (!isGroupJid(remoteJid)) {
    nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } })
  }

  return nodes
}

type NativeFlowButton = proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton

function unsupportedButton(btn: never): never {
  throw new Error(`Unsupported interactive button: ${JSON.stringify(btn)}`)
}

function toNativeFlowButton(btn: InteractiveButtonDef): NativeFlowButton {
  switch (btn.type) {
    case undefined:
    case 'reply':
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id }) }
    case 'url':
      return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.text, url: btn.url }) }
    case 'copy':
      return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: btn.text, copy_code: btn.code }) }
    case 'call':
      return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: btn.text, phone_number: btn.phone }) }
    case 'reminder':
      return { name: 'cta_reminder', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id ?? btn.text }) }
    case 'cancel-reminder':
      return { name: 'cta_cancel_reminder', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id ?? btn.text }) }
    case 'location':
      return { name: 'send_location', buttonParamsJson: JSON.stringify({ display_text: btn.text ?? 'Share Location' }) }
    case 'address':
      return { name: 'address_message', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id ?? randomUUID() }) }
    default:
      return unsupportedButton(btn)
  }
}

function renderFallbackButton(btn: InteractiveButtonDef, ordinal?: number): string {
  switch (btn.type) {
    case undefined:
    case 'reply':
      return `[${ordinal ?? btn.id}] ${btn.text}`
    case 'url':
      return `[🔗 ${btn.text}] (${btn.url})`
    case 'copy':
      return `[📋 ${btn.text}: ${btn.code}]`
    case 'call':
      return `[📞 ${btn.text}: ${btn.phone}]`
    case 'reminder':
    case 'cancel-reminder':
    case 'location':
    case 'address':
      return `[${btn.text ?? 'Share Location'}]`
    default:
      return unsupportedButton(btn)
  }
}

export function parseRichMarkdown(input: string): readonly AIRichPart[] {
  const trimmed = input.trim()
  if (!trimmed) return []

  const lines = trimmed.split(/\r?\n/)
  const parts: AIRichPart[] = []
  let currentTextLines: string[] = []

  const flushText = () => {
    if (currentTextLines.length > 0) {
      const content = currentTextLines.join('\n').trim()
      if (content) parts.push({ type: 'text', content })
      currentTextLines = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const rawLine = lines[i] ?? ''
    const line = rawLine.trim()

    if (line.startsWith('```')) {
      flushText()
      const lang = line.slice(3).trim() || 'plaintext'
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]?.trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '')
        i++
      }
      parts.push({
        type: 'code',
        content: codeLines.join('\n'),
        language: lang,
      })
      i++
      continue
    }

    if (line.startsWith(':::')) {
      flushText()
      const directive = line.slice(3).trim().toLowerCase()
      const directiveLines: string[] = []
      i++
      while (i < lines.length && !lines[i]?.trim().startsWith(':::')) {
        const dLine = lines[i]?.trim()
        if (dLine) directiveLines.push(dLine)
        i++
      }
      if (directive === 'suggest') {
        const suggestions = directiveLines
          .flatMap((dl) => dl.split('|'))
          .map((s) => s.trim().replace(/^[-*]\s*/, ''))
          .filter(Boolean)
        if (suggestions.length > 0) {
          parts.push({ type: 'suggest', content: suggestions.join(' | ') })
        }
      } else if (directive === 'tip') {
        const tipContent = directiveLines.join('\n').trim()
        if (tipContent) parts.push({ type: 'tip', content: tipContent })
      }
      i++
      continue
    }

    if (line.startsWith('|') && line.endsWith('|')) {
      const nextLine = lines[i + 1]?.trim() ?? ''
      if (nextLine.startsWith('|') && /^[|\s:-]+$/.test(nextLine)) {
        flushText()
        const tableLines: string[] = [line]
        i += 2
        while (i < lines.length && lines[i]?.trim().startsWith('|') && lines[i]?.trim().endsWith('|')) {
          tableLines.push(lines[i]?.trim() ?? '')
          i++
        }
        const parsedRows = tableLines.map((tl) =>
          tl
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim()),
        )
        parts.push({
          type: 'table',
          content: tableLines.join('\n'),
          rows: parsedRows,
        })
        continue
      }
    }

    currentTextLines.push(rawLine)
    i++
  }

  flushText()
  return parts
}

export class MsgBuilder {
  private readonly _remoteJid: string
  private _text = ''
  private _mentions: string[] = []
  private _rich = false
  private _buttons: InteractiveButtonDef[] = []
  private _headerTitle?: string
  private _headerSubtitle?: string
  private _footerText?: string
  private _listOptions?: ListOptions
  private _carouselCards?: readonly CarouselCardDef[]

  constructor(remoteJid: string) {
    this._remoteJid = remoteJid.trim()
  }

  static to(remoteJid: string): MsgBuilder {
    return new MsgBuilder(remoteJid)
  }

  text(
    content: string,
    options?: {
      readonly rich?: boolean
      readonly mentions?: readonly string[]
    },
  ): this {
    this._text = content
    if (options?.rich !== undefined) this._rich = options.rich
    if (options?.mentions !== undefined) this._mentions = [...options.mentions]
    return this
  }

  header(title: string, subtitle?: string): this {
    this._headerTitle = title.trim()
    if (subtitle) this._headerSubtitle = subtitle.trim()
    return this
  }

  footer(text: string): this {
    this._footerText = text.trim()
    return this
  }

  button(btn: InteractiveButtonDef): this {
    if (this._buttons.length >= 10) throw new Error('Maximum 10 buttons allowed')
    this._buttons.push(btn)
    return this
  }

  buttons(btns: readonly InteractiveButtonDef[]): this {
    if (btns.length === 0 || btns.length > 10) {
      throw new Error('Buttons must contain between 1 and 10 items')
    }
    this._buttons = [...btns]
    return this
  }

  list(options: ListOptions): this {
    if (!options.buttonText.trim()) throw new Error('List requires non-empty buttonText')
    if (options.sections.length === 0) throw new Error('List requires at least one section')
    const totalRows = options.sections.reduce((acc, sec) => acc + sec.rows.length, 0)
    if (totalRows === 0 || totalRows > 10) throw new Error('List must contain between 1 and 10 rows total')
    const ids = new Set<string>()
    for (const sec of options.sections) {
      for (const row of sec.rows) {
        const rowId = row.id.trim()
        if (!rowId || !row.title.trim()) throw new Error('List row requires non-empty id and title')
        if (ids.has(rowId)) throw new Error(`Duplicate list row ID: ${row.id}`)
        ids.add(rowId)
      }
    }
    this._listOptions = options
    return this
  }

  carousel(cards: readonly CarouselCardDef[]): this {
    if (cards.length === 0 || cards.length > 10) {
      throw new Error('Carousel requires between 1 and 10 cards')
    }
    this._carouselCards = cards
    return this
  }

  buildFallbackText(): string {
    const parts: string[] = []
    if (this._headerTitle) parts.push(`*${this._headerTitle}*`)
    if (this._headerSubtitle) parts.push(`_${this._headerSubtitle}_`)
    if (this._text.trim()) parts.push(this._text.trim())

    if (this._listOptions) {
      parts.push(`\n[${this._listOptions.buttonText}]`)
      for (const section of this._listOptions.sections) {
        parts.push(`*${section.title}*`)
        for (const row of section.rows) {
          parts.push(`• ${row.title} (${row.id})${row.description ? ` - ${row.description}` : ''}`)
        }
      }
    }

    if (this._carouselCards) {
      for (const [index, card] of this._carouselCards.entries()) {
        const cardLines: string[] = [card.title ? `*${index + 1}. ${card.title}*` : `*${index + 1}.*`]
        if (card.subtitle) cardLines.push(`_${card.subtitle}_`)
        if (card.body) cardLines.push(card.body)
        for (const cardButton of card.buttons ?? []) cardLines.push(renderFallbackButton(cardButton))
        if (card.footer) cardLines.push(`_${card.footer}_`)
        parts.push(cardLines.join('\n'))
      }
    }

    if (this._buttons.length > 0) {
      parts.push('\n' + this._buttons.map((b, idx) => renderFallbackButton(b, idx + 1)).join('\n'))
    }

    if (this._footerText) parts.push(`\n_${this._footerText}_`)
    return parts.join('\n\n')
  }

  build(): BuiltMessagePayload {
    const hasButtons = this._buttons.length > 0
    const hasList = Boolean(this._listOptions)
    const hasCarousel = Boolean(this._carouselCards?.length)

    if (this._rich) {
      if (hasButtons || hasList || hasCarousel) {
        throw new Error('AIRich mode cannot be combined with buttons, list or carousel — send them as separate messages')
      }
      const parts = parseRichMarkdown(this._text)
      if (parts.length === 0) {
        throw new Error('AIRich message content must not be empty')
      }

      const submessages: proto.AIRichResponseSubMessage[] = parts.map((part) => {
        if (part.type === 'code') {
          return proto.AIRichResponseSubMessage.create({
            messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_CODE,
            codeMetadata: proto.AIRichResponseCodeMetadata.create({
              codeLanguage: part.language ?? 'plaintext',
              codeBlocks: [
                proto.AIRichResponseCodeMetadata.AIRichResponseCodeBlock.create({
                  codeContent: part.content,
                  highlightType: proto.AIRichResponseCodeMetadata.AIRichResponseCodeHighlightType.AI_RICH_RESPONSE_CODE_HIGHLIGHT_DEFAULT,
                }),
              ],
            }),
          })
        }
        if (part.type === 'table') {
          return proto.AIRichResponseSubMessage.create({
            messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TABLE,
            tableMetadata: proto.AIRichResponseTableMetadata.create({
              title: 'Data Table',
              rows: (part.rows ?? []).map((row) =>
                proto.AIRichResponseTableMetadata.AIRichResponseTableRow.create({
                  items: [...row],
                }),
              ),
            }),
          })
        }
        return proto.AIRichResponseSubMessage.create({
          messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT,
          messageText: part.content,
        })
      })

      const richMsg = proto.AIRichResponseMessage.create({
        messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        submessages,
      })

      const fallbackText = this._text.trim()
      return {
        kind: 'airich',
        payload: {
          botInvokeMessage: {
            message: {
              richResponseMessage: richMsg,
            },
          },
        },
        fallbackText,
      }
    }

    if (hasButtons || hasList || hasCarousel) {
      const nativeButtons: NativeFlowButton[] = []
      const replyIds = new Set<string>()

      for (const btn of this._buttons) {
        if (!btn.type || btn.type === 'reply') {
          if (replyIds.has(btn.id)) throw new Error(`Duplicate reply button ID: ${btn.id}`)
          replyIds.add(btn.id)
        }
        nativeButtons.push(toNativeFlowButton(btn))
      }

      if (this._listOptions) {
        nativeButtons.push({
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: this._listOptions.buttonText,
            sections: this._listOptions.sections.map((s) => ({
              title: s.title,
              rows: s.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
            })),
          }),
        })
      }

      const interactive = proto.Message.InteractiveMessage.create({
        body: proto.Message.InteractiveMessage.Body.create({ text: this._text.trim() || ' ' }),
        ...(this._footerText ? { footer: proto.Message.InteractiveMessage.Footer.create({ text: this._footerText }) } : {}),
        ...(this._headerTitle ? {
          header: proto.Message.InteractiveMessage.Header.create({
            title: this._headerTitle,
            subtitle: this._headerSubtitle,
            hasMediaAttachment: false,
          }),
        } : {}),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
          messageVersion: 1,
          buttons: nativeButtons,
        }),
      })

      if (this._carouselCards?.length) {
        interactive.carouselMessage = proto.Message.InteractiveMessage.CarouselMessage.create({
          cards: this._carouselCards.map((card) =>
            proto.Message.InteractiveMessage.create({
              body: proto.Message.InteractiveMessage.Body.create({ text: card.body ?? ' ' }),
              ...(card.footer ? { footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footer }) } : {}),
              ...(card.title ? {
                header: proto.Message.InteractiveMessage.Header.create({
                  title: card.title,
                  subtitle: card.subtitle,
                  hasMediaAttachment: false,
                }),
              } : {}),
              nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: (card.buttons ?? []).map(toNativeFlowButton),
              }),
            }),
          ),
        })
      }

      return {
        kind: 'interactive',
        payload: { interactiveMessage: interactive },
        fallbackText: this.buildFallbackText(),
      }
    }

    if (!this._text.trim()) throw new Error('Message text must not be empty')

    return {
      kind: 'text',
      text: this._text,
      mentions: this._mentions.length > 0 ? this._mentions : undefined,
    }
  }

  async send(transport: WhatsAppPort & { socket?: WASocket }): Promise<void> {
    const built = this.build()
    const jid = this._remoteJid

    if (built.kind === 'text') {
      await transport.sendText(jid, built.text, built.mentions ? { mentions: built.mentions } : undefined)
      return
    }

    const socket = transport.socket
    if (!socket || !transport.isConnected) {
      await transport.sendText(jid, built.fallbackText)
      return
    }

    try {
      if (built.kind === 'interactive') {
        const msg = proto.Message.create({
          interactiveMessage: built.payload.interactiveMessage,
        })
        await socket.relayMessage(jid, msg, {
          messageId: generateMessageIDV2(socket.user?.id),
          additionalNodes: nativeFlowAdditionalNodes(jid),
        })
      } else if (built.kind === 'airich') {
        const msg = proto.Message.create({
          botInvokeMessage: built.payload.botInvokeMessage,
        })
        await socket.relayMessage(jid, msg, {
          messageId: generateMessageIDV2(socket.user?.id),
          additionalNodes: nativeFlowAdditionalNodes(jid, false),
        })
      }
    } catch (error) {
      socket.logger?.warn({ err: error, jid, kind: built.kind }, 'native flow relay failed, falling back to plain text')
      await transport.sendText(jid, built.fallbackText)
    }
  }
}
