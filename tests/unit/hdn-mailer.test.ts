import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import { createMailer, MemoryMailer, queueMail, setMailerForTests } from '@/modules/hdn/mailer';
import { MailError } from '@/modules/hdn/resend';
import {
  CONFIRM_EMAIL_MINUTES,
  confirmEmailMail,
  INVITATION_DAYS,
  invitationMail,
  LOGIN_LINK_MINUTES,
  loginLinkMail,
  STAFF_LINK_HOURS,
  staffInvitationMail,
  staffResetMail,
  telegramLinkedMail,
} from '@/modules/hdn/mail-text';
import { EMAIL_TOKEN_TTL_SEC, INVITATION_TTL_SEC, LOGIN_LINK_TTL_SEC, STAFF_INVITATION_TTL_SEC } from '@/modules/hdu/pref';

test('режим none ничего не отправляет и не пишет адрес и ссылку в журнал', async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((line) => void lines.push(String(line)));
  await createMailer({ MAIL_TRANSPORT: 'none' }).send({
    to: 'person@example.test',
    subject: 's',
    text: 'https://hub/ru/login/link?token=abc',
    kind: 'login-link',
  });
  expect(lines.join('\n')).toContain('login-link');
  expect(lines.join('\n')).not.toContain('person@example.test');
  expect(lines.join('\n')).not.toContain('token=abc');
  spy.mockRestore();
});

test('режим console печатает письмо целиком', async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((line) => void lines.push(String(line)));
  await createMailer({ MAIL_TRANSPORT: 'console' }).send({ to: 'a@example.test', subject: 'Тема', text: 'Текст', kind: 'confirm-email' });
  expect(lines.join('\n')).toContain('a@example.test');
  expect(lines.join('\n')).toContain('Текст');
  spy.mockRestore();
});

test('режим file кладёт письмо в каталог', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-'));
  await createMailer({ MAIL_TRANSPORT: 'file', MAIL_FILE_DIR: dir }).send({ to: 'a@example.test', subject: 's', text: 't', kind: 'confirm-email' });
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, files[0] as string), 'utf8'))).toMatchObject({ to: 'a@example.test', kind: 'confirm-email', text: 't' });
});

test('письма в памяти видны сразу после вызова', () => {
  const mailer = new MemoryMailer();
  void mailer.send({ to: 'a@example.test', subject: 's', text: 't', kind: 'login-link' });
  expect(mailer.sent).toHaveLength(1);
});

test('тексты писем есть на трёх языках и содержат ссылку и срок', () => {
  for (const locale of LOCALES) {
    const login = loginLinkMail(locale, 'https://hub.example/x');
    expect(login.subject.length).toBeGreaterThan(5);
    expect(login.text).toContain('https://hub.example/x');
    expect(login.text).toContain('15');
    const confirm = confirmEmailMail(locale, 'https://hub.example/y');
    expect(confirm.text).toContain('https://hub.example/y');
    expect(confirm.text).toContain('60');
    const invite = invitationMail(locale, { url: 'https://hub.example/z', orgName: 'ACME Trade', inviterName: 'Дильноза' });
    expect(invite.subject).not.toContain('Дильноза');
    expect(invite.text).toContain('Дильноза');
    expect(invite.text).toContain('ACME Trade');
    expect(invite.text).toContain('https://hub.example/z');
    for (const mail of [login, confirm, invite]) expect(`${mail.subject}${mail.text}`).not.toMatch(/[{}]/);
  }
});

test('срок в тексте письма совпадает со сроком ссылки (проверка main, Q12)', () => {
  expect(LOGIN_LINK_MINUTES * 60).toBe(LOGIN_LINK_TTL_SEC);
  expect(CONFIRM_EMAIL_MINUTES * 60).toBe(EMAIL_TOKEN_TTL_SEC);
  expect(INVITATION_DAYS * 24 * 3600).toBe(INVITATION_TTL_SEC);
});

test('письма сотрудникам: ссылка и срок на трёх языках, срок совпадает со сроком приглашения', () => {
  for (const locale of ['ru', 'uz', 'en'] as const) {
    const invite = staffInvitationMail(locale, { url: 'https://hub.example/s', inviterName: 'Рустам' });
    expect(invite.subject).not.toContain('Рустам');
    expect(invite.text).toContain('Рустам');
    expect(invite.text).toContain('https://hub.example/s');
    expect(invite.text).toContain('24');
    const reset = staffResetMail(locale, { url: 'https://hub.example/r' });
    expect(reset.text).toContain('https://hub.example/r');
    for (const mail of [invite, reset]) expect(`${mail.subject}${mail.text}`).not.toMatch(/[{}]/);
  }
  expect(STAFF_LINK_HOURS * 3600).toBe(STAFF_INVITATION_TTL_SEC);
});

test('имя из Smartup попадает в письмо приглашения без ссылок, управляющих знаков и лишней длины (проверка main, S8)', () => {
  const text = (inviterName: string, orgName = 'ACME Trade') => invitationMail('ru', { url: 'https://hub.example/z', orgName, inviterName }).text;
  // Имя со ссылкой заменяется общим словом: письмо не служит приманкой с чужим адресом.
  for (const bad of ['Откройте https://evil.example', 'Зайдите на evil-login.com', 'www.evil.example', 'Алишер (evil.uz/pay)']) {
    expect(text(bad), bad).not.toMatch(/evil/);
    expect(text(bad), bad).toContain('Ваш коллега');
  }
  // Управляющие знаки и знаки направления текста убираются, пробелы схлопываются.
  expect(text('Али\u202Eшер\u0000\n\nКаримов')).toContain('Алишер Каримов приглашает');
  // Длинное имя обрезается.
  const long = text('А'.repeat(300));
  expect(long).toContain(`${'А'.repeat(60)}... приглашает`);
  expect(long).not.toContain('А'.repeat(61));
  // Название организации без управляющих знаков и не длиннее предела.
  expect(text('Дильноза', 'ACME\u202E Trade\r\nBcc: x')).toContain('ACME Trade Bcc: x в Smartup Hub');
  expect(staffInvitationMail('ru', { url: 'https://hub.example/s', inviterName: 'см. http://evil.example' }).text).toContain('Администратор портала');
  for (const locale of LOCALES) {
    expect(invitationMail(locale, { url: 'https://hub.example/z', orgName: 'ACME', inviterName: 'x.com' }).text).not.toContain('x.com');
    expect(staffInvitationMail(locale, { url: 'https://hub.example/s', inviterName: 'x.com' }).text).not.toContain('x.com');
  }
});

test('почта none сообщает, что письма не доходят, остальные виды доходят', () => {
  expect(createMailer({ MAIL_TRANSPORT: 'none' }).delivers).toBe(false);
  expect(createMailer({ MAIL_TRANSPORT: 'console' }).delivers).toBe(true);
  expect(new MemoryMailer().delivers).toBe(true);
});

test('сбой письма пишется в журнал одной строкой с кодом ответа сервиса (проверка main, Q16)', async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((line) => void lines.push(String(line)));
  setMailerForTests({ delivers: true, send: async () => Promise.reject(new MailError(422)) });
  queueMail({ to: 'person@example.test', subject: 'Тема', text: 'https://hub.example/x', kind: 'invitation' });
  await new Promise((done) => setImmediate(done));
  setMailerForTests({ delivers: true, send: async () => Promise.reject(new MailError(null)) });
  queueMail({ to: 'person@example.test', subject: 'Тема', text: 'x', kind: 'login-link' });
  await new Promise((done) => setImmediate(done));
  setMailerForTests(null);
  spy.mockRestore();
  expect(lines).toEqual(['Письмо invitation не отправлено: код 422', 'Письмо login-link не отправлено: нет ответа']);
});

test('отображаемое имя Telegram и название организации в письмах без ссылок (итоговая проверка доработки)', () => {
  const linked = (account: string) => telegramLinkedMail('ru', { account, url: 'https://hub.example/p' }).text;
  expect(linked('@alisher_k')).toContain('@alisher_k');
  for (const bad of ['Срочно https://evil.example', 'evil-login.com', 'a‮b www.evil.example'])
    expect(linked(bad), bad).not.toMatch(/evil/);
  expect(linked('Алишер\nКаримов')).toContain('Алишер Каримов');
  // Название организации со ссылкой остаётся узнаваемым, но почтовая программа не сделает из него ссылку.
  const text = invitationMail('ru', { url: 'https://hub.example/z', orgName: 'Перейдите на evil.example', inviterName: 'Дильноза' }).text;
  expect(text).not.toContain('evil.example');
  expect(text).toContain('evil․example');
  // Инициалы с точкой ссылкой не считаются.
  expect(invitationMail('ru', { url: 'https://hub.example/z', orgName: 'ACME', inviterName: 'А.Каримов' }).text).toContain('А.Каримов приглашает');
});
