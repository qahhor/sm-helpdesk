import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
import en from '../../../messages/en.json';
import ru from '../../../messages/ru.json';
import uz from '../../../messages/uz.json';

// Тексты бота Telegram (задача 16). Лежат в messages/*.json, пространство bot: переводятся
// как интерфейс и проходят те же проверки слов.

const MESSAGES = { ru, uz, en } as const;

export const BOT_TEXT_KEYS = [
  'linked',
  'alreadyLinked',
  'codeInvalid',
  'unlinked',
  'notLinked',
  'chooseLanguage',
  'languageSet',
  'languageName',
  'fallback',
  'buttonPortal',
  'buttonSignIn',
  'buttonLanguage',
  'buttonUnlink',
  'loginLink',
  'loginTooOften',
  'loginNoAccess',
] as const;

export type BotTextKey = (typeof BOT_TEXT_KEYS)[number];

/** Текст бота на языке собеседника. values: параметры текста (имя, организация, минуты). */
export function botText(locale: Locale, key: BotTextKey, values: Record<string, string> = {}): string {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: 'bot' })(key, values);
}
