import { expect, test } from 'vitest';
import { checkMailDns, type DnsResolver } from '../../scripts/ops/mail-dns-check.mjs';

// Записи почты поддоменов ТЗ 13.10 (план M9, задача 10, решение 18): scripts/ops/mail-dns-check.mjs с подменённым
// resolver. Домен отправки: SPF Resend на send.<домен> только с include:amazonses.com, ключ DKIM resend._domainkey,
// DMARC; домен приёма: запись MX. p=none допустима первый месяц (памятка запуска, раздел 4), но это находка.

const GOOD: Record<string, string[][]> = {
  'send.mail.smartup24.com': [['v=spf1 include:amazonses.com ~all']],
  'resend._domainkey.mail.smartup24.com': [['p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC']],
  '_dmarc.mail.smartup24.com': [['v=DMARC1; p=quarantine; rua=mailto:dmarc@smartup24.com']],
};
const MX: Record<string, { exchange: string; priority: number }[]> = {
  'reply.smartup24.com': [{ exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }],
  'send.mail.smartup24.com': [{ exchange: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 }],
};

const resolver = (txt: Record<string, string[][]> = GOOD, mx = MX): DnsResolver => ({
  resolveTxt: async (name: string) => {
    if (!(name in txt)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return txt[name]!;
  },
  resolveMx: async (name: string) => {
    if (!(name in mx)) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    return mx[name]!;
  },
});
const run = (r: DnsResolver) => checkMailDns({ mail: 'mail.smartup24.com', reply: 'reply.smartup24.com' }, r);

test('верные записи проходят без находок', async () => {
  expect(await run(resolver())).toEqual([]);
});

test('нет DKIM: ошибка; DMARC p=none: предупреждение; нет rua: предупреждение', async () => {
  const txt = { ...GOOD, '_dmarc.mail.smartup24.com': [['v=DMARC1; p=none']] };
  delete (txt as Record<string, unknown>)['resend._domainkey.mail.smartup24.com'];
  expect(await run(resolver(txt))).toEqual([
    { domain: 'resend._domainkey.mail.smartup24.com', check: 'dkim', level: 'error', message: 'нет ключа DKIM Resend' },
    { domain: '_dmarc.mail.smartup24.com', check: 'dmarc', level: 'warn', message: 'политика p=none: письма с подделанным адресом не отклоняются; ужесточить до quarantine через месяц без ошибок' },
    { domain: '_dmarc.mail.smartup24.com', check: 'dmarc', level: 'warn', message: 'нет адреса отчётов rua' },
  ]);
});

test('лишний include в SPF, две записи SPF, нет DMARC и MX приёма: ошибки', async () => {
  const extra = await run(resolver({ ...GOOD, 'send.mail.smartup24.com': [['v=spf1 include:amazonses.com include:_spf.google.com ~all']] }));
  expect(extra).toEqual([{ domain: 'send.mail.smartup24.com', check: 'spf', level: 'error', message: 'лишний include:_spf.google.com' }]);
  const twice = await run(resolver({ ...GOOD, 'send.mail.smartup24.com': [['v=spf1 include:amazonses.com ~all'], ['v=spf1 -all']] }));
  expect(twice.map((f) => f.message)).toEqual(['записей SPF две: почтовые серверы считают SPF неверным']);
  const none = { ...GOOD };
  delete (none as Record<string, unknown>)['_dmarc.mail.smartup24.com'];
  expect(await run(resolver(none, { 'send.mail.smartup24.com': MX['send.mail.smartup24.com']! }))).toEqual([
    { domain: '_dmarc.mail.smartup24.com', check: 'dmarc', level: 'error', message: 'нет записи DMARC' },
    { domain: 'reply.smartup24.com', check: 'mx', level: 'error', message: 'нет записи MX: письма на адрес приёма не дойдут' },
  ]);
});

test('SPF без ~all или -all и разрешающий +all: ошибка', async () => {
  expect((await run(resolver({ ...GOOD, 'send.mail.smartup24.com': [['v=spf1 include:amazonses.com +all']] }))).map((f) => f.message)).toEqual(['+all разрешает отправку кому угодно']);
  expect((await run(resolver({ ...GOOD, 'send.mail.smartup24.com': [['v=spf1 include:amazonses.com']] }))).map((f) => f.message)).toEqual(['нет завершающего ~all или -all']);
});
