import { esc, link } from './html';
import tokens from './mail-tokens.json';

// Модуль hdn: оболочка письма (решение 4 вехи M4). Таблицы и стили в атрибутах: так письмо одинаково выглядит
// в почтовых программах. Значения оформления только из mail-tokens.json (строит scripts/gen-mail-tokens.mjs).

const c = tokens.color;
const s = tokens.space;

export const PARAGRAPH = `margin:0 0 ${s[4]};font-size:${tokens.font.size};line-height:${tokens.font.lineHeight};color:${c.foreground}`;
export const LINK_COLOR = c.link;
const SMALL = `margin:0 0 ${s[2]};font-size:${tokens.font.size};line-height:${tokens.font.lineHeight};color:${c.muted}`;

/** Логотип из пакета бренда (docs/brand/logo, копия в public/brand/logo): только этот файл, раздел 8.13 ТЗ. */
export const LOGO_PATH = '/brand/logo/smartup-logo-light-bg.png';

export type LayoutText = {
  replyAbove: string;
  signature: string;
  support: string | null;
  settings: string;
  contacts: string;
};

export type LayoutInput = {
  hubUrl: string;
  lang: string;
  title: string;
  heading: string | null;
  bodyHtml: string;
  button: { label: string; url: string } | null;
  /** Строка "Ответьте на это письмо" над чертой: её ищет разбор цитаты входящего письма (задача 7). */
  replyHint: boolean;
  signature: boolean;
  settingsUrl: string | null;
  text: LayoutText;
};

export function renderLayout(input: LayoutInput): string {
  const { text } = input;
  const logo = `${input.hubUrl}${LOGO_PATH}`;
  const reply = input.replyHint
    ? `<p style="${SMALL}">${esc(text.replyAbove)}</p><hr style="border:none;border-top:${tokens.border.width} solid ${c.line};margin:0 0 ${s[6]}">`
    : '';
  const heading = input.heading
    ? `<h1 style="margin:0 0 ${s[4]};font-size:${tokens.font.size};line-height:${tokens.font.lineHeight};font-weight:700;color:${c.foreground}">${esc(input.heading)}</h1>`
    : '';
  const button = input.button
    ? `<p style="margin:${s[6]} 0"><a href="${esc(input.button.url)}" style="display:inline-block;padding:${s[3]} ${s[6]};min-height:${tokens.control.height};box-sizing:border-box;line-height:${tokens.font.lineHeight};background:${c.primary};color:${c.onPrimary};border-radius:${tokens.radius.control};font-weight:600;text-decoration:none">${esc(input.button.label)}</a></p>`
    : '';
  const signature = input.signature ? `<p style="${PARAGRAPH}">${esc(text.signature)}</p>` : '';
  const support = text.support ? `<p style="${SMALL}">${esc(text.support)}</p>` : '';
  const settings = input.settingsUrl ? `<p style="${SMALL}">${link(input.settingsUrl, text.settings, c.link)}</p>` : '';
  return [
    '<!DOCTYPE html>',
    `<html lang="${esc(input.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(input.title)}</title></head>`,
    `<body style="margin:0;padding:0;background:${c.background};font-family:${esc(tokens.font.family)}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.background}"><tr><td align="center" style="padding:${s[6]} ${s[4]}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${tokens.width.content};background:${c.card};border-radius:${tokens.radius.card}"><tr><td style="padding:${s[8]} ${s[6]}">`,
    reply,
    `<p style="margin:0 0 ${s[6]}"><img src="${esc(logo)}" alt="Smartup" height="${Number.parseInt(tokens.logo.height, 10)}" style="display:block;height:${tokens.logo.height};border:0"></p>`,
    heading,
    input.bodyHtml,
    button,
    signature,
    '</td></tr></table>',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${tokens.width.content}"><tr><td style="padding:${s[4]} ${s[6]}">`,
    support,
    `<p style="${SMALL}">${esc(text.contacts)}</p>`,
    settings,
    '</td></tr></table>',
    '</td></tr></table></body></html>',
  ].join('');
}

/** Текстовая часть письма в том же порядке, что HTML. */
export function renderLayoutText(input: Omit<LayoutInput, 'bodyHtml' | 'lang' | 'title'> & { bodyText: string }): string {
  const { text } = input;
  const parts: string[] = [];
  if (input.replyHint) parts.push(text.replyAbove, '------------------------------------------------------------', '');
  if (input.heading) parts.push(input.heading, '');
  parts.push(input.bodyText.trim(), '');
  if (input.button) parts.push(`${input.button.label}: ${input.button.url}`, '');
  if (input.signature) parts.push(text.signature, '');
  parts.push('--');
  if (text.support) parts.push(text.support);
  parts.push(text.contacts);
  if (input.settingsUrl) parts.push(`${text.settings}: ${input.settingsUrl}`);
  return parts.join('\n');
}
