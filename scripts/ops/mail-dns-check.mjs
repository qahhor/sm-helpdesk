#!/usr/bin/env node
// Записи почты поддоменов ТЗ 13.10 (план M9, задача 10, решение 18). Только читает DNS (node:dns) и печатает
// расхождения: SPF Resend на send.<домен отправки> (только include:amazonses.com, завершение ~all или -all), ключ DKIM
// resend._domainkey.<домен отправки>, политика DMARC _dmarc.<домен отправки>, MX домена приёма ответов и MX обратной
// связи send.<домен отправки>. Доставку на Gmail, Mail.ru, Yandex и подделку DMARC проверяют руками по памятке
// запуска (раздел 11). Код завершения 1, если есть ошибки; предупреждения кода не меняют.
//
// Запуск: node scripts/ops/mail-dns-check.mjs --mail mail.smartup24.com --reply reply.smartup24.com
import { Resolver } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ resolveTxt(name: string): Promise<string[][]>; resolveMx(name: string): Promise<{ exchange: string; priority: number }[]> }} DnsResolver
 * @typedef {{ domain: string; check: 'spf' | 'dkim' | 'dmarc' | 'mx'; level: 'error' | 'warn'; message: string }} DnsFinding
 */

/** Разрешённые включения SPF: Resend отправляет через Amazon SES. */
const SPF_INCLUDES = new Set(['amazonses.com']);
const DKIM_SELECTOR = 'resend';

/** @param {DnsResolver} resolver @param {string} name @returns {Promise<string[]>} */
async function txt(resolver, name) {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

/** @param {DnsResolver} resolver @param {string} name */
async function mx(resolver, name) {
  try {
    return await resolver.resolveMx(name);
  } catch {
    return [];
  }
}

/**
 * @param {{ mail: string; reply: string }} domains домен отправки и домен приёма
 * @param {DnsResolver} resolver
 * @returns {Promise<DnsFinding[]>}
 */
export async function checkMailDns(domains, resolver) {
  /** @type {DnsFinding[]} */
  const findings = [];
  const add = (domain, check, level, message) => findings.push({ domain, check, level, message });

  const spfHost = `send.${domains.mail}`;
  const spf = (await txt(resolver, spfHost)).filter((record) => /^v=spf1(\s|$)/i.test(record));
  if (spf.length === 0) add(spfHost, 'spf', 'error', 'нет записи SPF');
  else if (spf.length > 1) add(spfHost, 'spf', 'error', 'записей SPF две: почтовые серверы считают SPF неверным');
  else {
    const terms = spf[0].split(/\s+/).slice(1);
    for (const term of terms) {
      const include = /^include:(.+)$/i.exec(term)?.[1];
      if (include && !SPF_INCLUDES.has(include.toLowerCase())) add(spfHost, 'spf', 'error', `лишний include:${include}`);
    }
    if (!terms.some((term) => /^include:amazonses\.com$/i.test(term))) add(spfHost, 'spf', 'error', 'нет include:amazonses.com');
    if (terms.includes('+all') || terms.includes('all')) add(spfHost, 'spf', 'error', '+all разрешает отправку кому угодно');
    else if (!terms.includes('~all') && !terms.includes('-all')) add(spfHost, 'spf', 'error', 'нет завершающего ~all или -all');
  }

  const dkimHost = `${DKIM_SELECTOR}._domainkey.${domains.mail}`;
  if (!(await txt(resolver, dkimHost)).some((record) => /(^|;)\s*p=[A-Za-z0-9+/=]{20,}/.test(record))) add(dkimHost, 'dkim', 'error', 'нет ключа DKIM Resend');

  const dmarcHost = `_dmarc.${domains.mail}`;
  const dmarc = (await txt(resolver, dmarcHost)).find((record) => /^v=DMARC1/i.test(record));
  if (!dmarc) add(dmarcHost, 'dmarc', 'error', 'нет записи DMARC');
  else {
    const policy = /(^|;)\s*p=(\w+)/i.exec(dmarc)?.[2]?.toLowerCase();
    if (!policy) add(dmarcHost, 'dmarc', 'error', 'нет политики p=');
    else if (policy === 'none') add(dmarcHost, 'dmarc', 'warn', 'политика p=none: письма с подделанным адресом не отклоняются; ужесточить до quarantine через месяц без ошибок');
    if (!/(^|;)\s*rua=mailto:/i.test(dmarc)) add(dmarcHost, 'dmarc', 'warn', 'нет адреса отчётов rua');
  }

  if ((await mx(resolver, domains.reply)).length === 0) add(domains.reply, 'mx', 'error', 'нет записи MX: письма на адрес приёма не дойдут');
  if ((await mx(resolver, spfHost)).length === 0) add(spfHost, 'mx', 'warn', 'нет записи MX обратной связи Resend: отказы доставки не вернутся');
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const mail = arg('mail');
  const reply = arg('reply');
  if (!mail || !reply) {
    console.error('Использование: node scripts/ops/mail-dns-check.mjs --mail <домен отправки> --reply <домен приёма>');
    process.exit(2);
  }
  const findings = await checkMailDns({ mail, reply }, new Resolver());
  for (const f of findings) console.log(`${f.level === 'error' ? 'ошибка' : 'внимание'}: ${f.domain} ${f.check}: ${f.message}`);
  const errors = findings.filter((f) => f.level === 'error').length;
  console.log(errors === 0 ? `Итог: ошибок нет${findings.length > 0 ? `, предупреждений ${findings.length}` : ''}` : `Итог: ошибок ${errors}`);
  process.exit(errors === 0 ? 0 : 1);
}
