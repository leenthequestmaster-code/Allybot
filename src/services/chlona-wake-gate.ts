import type { CoreMessage, WhatsAppPort } from '../framework/contracts.js'
import { isSameJid } from '../permissions.js'
import { isGroupJid } from '../framework/validation.js'

export interface ChlonaWakeDecision {
  readonly triggered: boolean
  readonly cleanText: string
  readonly triggerKind: 'mention' | 'reply' | 'audio' | 'dm' | 'none'
  readonly reason: string
  readonly mentionsBotToken: boolean
}

const BOT_NAME_TOKEN_REGEX = /(?:^|[\s([{"'])@?(?:chlona|allybot|ally)(?=$|[\s,.:;!?)\]}"'])/i
const THIRD_PERSON_PREFIX_REGEX = /\b(?:si|kata|katanya|tadi|kemarin|soal|tentang|kayak(?:nya)?|mirip|sama|buat|untuk|dari|sama-sama|itu\s+si)\s+@?(?:chlona|allybot|ally)\b/i
const THIRD_PERSON_VERB_REGEX = /\b@?(?:chlona|allybot|ally)\s+(?:lagi\s+(?:error|down|lemot|off|offline|tidur|ngaco|kocak|lucu|bener|salah)|tadi\s+|kemarin\s+|itu\s+(?:bot|ai|asisten)|memang\s+|emang\s+|sering\s+|pernah\s+|bisa\s+apa\s+aja\s+sih\s+katanya)/i
const DIRECT_ADDRESSED_REGEX = /^(?:(?:halo|hai|hi|hei|hey|oi|eh|permisi|tolong|coba|misi|p|woi|bro|min)\s+)*@?(?:chlona|allybot|ally)\b|^@?(?:chlona|allybot|ally)\s*[,:!?-]|@?(?:chlona|allybot|ally)\s+(?:tolong|coba|bantu(?:in)?|jelas(?:in|kan)?|cek(?:in)?|cari(?:in)?|hitung(?:in)?|simulasi(?:in)?|inget(?:in)?|buat(?:in|kan)?|bikin(?:in)?|putar(?:in)?|play|rekap|rangkum|kasih|kirim|menu|reset|clear)\b|\b(?:dong|ya|nih|sih|gimana|kenapa|berapa|kapan|apa|siapa|mana)\s*@?(?:chlona|allybot|ally)\s*[?!]*$/i

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function detectChlonaWake(
  message: CoreMessage,
  whatsapp: Pick<WhatsAppPort, 'userJid' | 'userLid'> | undefined,
): ChlonaWakeDecision {
  const rawText = message.text?.trim() ?? ''
  const isAudio = message.media?.kind === 'audio'
  const isGroup = isGroupJid(message.remoteJid)

  const botJid = whatsapp?.userJid
  const botLid = whatsapp?.userLid
  const botPhone = botJid?.split('@')[0]?.split(':')[0]
  const botLidBare = botLid?.split('@')[0]?.split(':')[0]

  // 1. Native WhatsApp @mention in mentionedJids
  const mentionedBotNatively = (message.mentionedJids ?? []).some(
    (jid) => (botJid && isSameJid(jid, botJid)) || (botLid && isSameJid(jid, botLid)),
  )

  const tokenParts = ['chlona', 'allybot', 'ally']
  if (botPhone) tokenParts.push(escapeRegExp(botPhone))
  if (botLidBare) tokenParts.push(escapeRegExp(botLidBare))
  const tokenGroup = tokenParts.join('|')

  const explicitHandleRegex = new RegExp(`(?:^|\\s)@(?:${tokenGroup})\\b`, 'i')
  const phoneTokens = [botPhone, botLidBare].filter((v): v is string => Boolean(v))
  const phoneMentionRegex = phoneTokens.length > 0
    ? new RegExp(`(?:^|\\s)@?(?:${phoneTokens.map(escapeRegExp).join('|')})\\b`, 'i')
    : undefined

  const hasNameToken = BOT_NAME_TOKEN_REGEX.test(rawText)
  const hasExplicitHandle = explicitHandleRegex.test(rawText) || Boolean(phoneMentionRegex?.test(rawText))

  const stripRegex = new RegExp(`(?:^|\\s)@?(?:${tokenGroup})\\b[,:!\\s]*`, 'gi')
  const cleanMentionText = rawText.replace(stripRegex, ' ').replace(/\s+/g, ' ').trim()

  if (mentionedBotNatively || hasExplicitHandle) {
    return {
      triggered: true,
      cleanText: cleanMentionText,
      triggerKind: 'mention',
      reason: mentionedBotNatively ? 'native_jid_mention' : 'explicit_at_handle',
      mentionsBotToken: true,
    }
  }

  // 2. Direct reply to bot's own message
  const quotedSender = message.quotedSenderJid ?? message.rawQuotedSenderJid
  const repliedToBotJid =
    Boolean(quotedSender) &&
    ((Boolean(botJid) && isSameJid(quotedSender, botJid)) || (Boolean(botLid) && isSameJid(quotedSender, botLid)))
  const quotedLooksLikeAi = Boolean(
    message.quotedText && /(?:Chlona|Allybot|\bAI\b|^🤖)/i.test(message.quotedText.trim()),
  )
  if (repliedToBotJid || (!quotedSender && quotedLooksLikeAi)) {
    return {
      triggered: true,
      cleanText: rawText,
      triggerKind: 'reply',
      reason: repliedToBotJid ? 'reply_to_bot_jid' : 'reply_to_bot_text_heuristic',
      mentionsBotToken: hasNameToken,
    }
  }

  // 3. Unprefixed bot name in group: structural Addressed-to-Bot vs Talking-about-Bot
  if (hasNameToken) {
    if (!isGroup) {
      return {
        triggered: true,
        cleanText: cleanMentionText,
        triggerKind: 'dm',
        reason: 'dm_named_chlona',
        mentionsBotToken: true,
      }
    }

    if (DIRECT_ADDRESSED_REGEX.test(rawText)) {
      return {
        triggered: true,
        cleanText: cleanMentionText,
        triggerKind: 'mention',
        reason: 'group_addressed_structural',
        mentionsBotToken: true,
      }
    }

    if (THIRD_PERSON_PREFIX_REGEX.test(rawText) || THIRD_PERSON_VERB_REGEX.test(rawText)) {
      return {
        triggered: false,
        cleanText: rawText,
        triggerKind: 'none',
        reason: 'talking_about_bot_third_person',
        mentionsBotToken: true,
      }
    }

    // Question mark / imperative / vocative at start or end
    const startsWithVocative = /^(?:chlona|allybot|ally)[a-z]{0,2}\b/i.test(rawText)
    const endsWithVocative = /(?:,|\s)(?:chlona|allybot|ally)[a-z]{0,2}[?!.]*$/i.test(rawText)
    if (startsWithVocative || endsWithVocative) {
      return {
        triggered: true,
        cleanText: cleanMentionText,
        triggerKind: 'mention',
        reason: startsWithVocative ? 'vocative_start' : 'vocative_end',
        mentionsBotToken: true,
      }
    }

    return {
      triggered: false,
      cleanText: rawText,
      triggerKind: 'none',
      reason: 'ambiguous_mid_sentence_mention_ignored',
      mentionsBotToken: true,
    }
  }

  // 4. Audio or direct DM report/audio without prefix
  if (isAudio && !isGroup) {
    return { triggered: true, cleanText: '', triggerKind: 'audio', reason: 'dm_audio', mentionsBotToken: false }
  }
  if (!isGroup && rawText && /\b(?:spam|rusuh|toxic|toksik|promosi|poaching|nsfw|gore|doxx?(?:ing)?|sara|ragebait|lapor(?:in|kan)?|melanggar|uu\s*ooc)\b/i.test(rawText)) {
    return { triggered: true, cleanText: rawText, triggerKind: 'dm', reason: 'dm_moderation_report', mentionsBotToken: false }
  }

  return { triggered: false, cleanText: rawText, triggerKind: 'none', reason: 'no_wake_signal', mentionsBotToken: false }
}
