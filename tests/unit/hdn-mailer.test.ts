import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import { createMailer, MemoryMailer } from '@/modules/hdn/mailer';
import {
  CONFIRM_EMAIL_MINUTES,
  confirmEmailMail,
  invitationMail,
  LOGIN_LINK_MINUTES,
  loginLinkMail,
  STAFF_LINK_HOURS,
  staffInvitationMail,
  staffResetMail,
} from '@/modules/hdn/mail-text';
import { LOGIN_LINK_TTL_SEC, STAFF_INVITATION_TTL_SEC } from '@/modules/hdu/pref';

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
    expect(invite.subject).toContain('Дильноза');
    expect(invite.text).toContain('ACME Trade');
    expect(invite.text).toContain('https://hub.example/z');
    for (const mail of [login, confirm, invite]) expect(`${mail.subject}${mail.text}`).not.toMatch(/[{}]/);
  }
});

test('срок в тексте письма совпадает со сроком ссылки', () => {
  expect(LOGIN_LINK_MINUTES * 60).toBe(LOGIN_LINK_TTL_SEC);
  expect(CONFIRM_EMAIL_MINUTES).toBe(60);
});

test('письма сотрудникам: ссылка и срок на трёх языках, срок совпадает со сроком приглашения', () => {
  for (const locale of ['ru', 'uz', 'en'] as const) {
    const invite = staffInvitationMail(locale, { url: 'https://hub.example/s', inviterName: 'Рустам' });
    expect(invite.subject).toContain('Рустам');
    expect(invite.text).toContain('https://hub.example/s');
    expect(invite.text).toContain('24');
    const reset = staffResetMail(locale, { url: 'https://hub.example/r' });
    expect(reset.text).toContain('https://hub.example/r');
    for (const mail of [invite, reset]) expect(`${mail.subject}${mail.text}`).not.toMatch(/[{}]/);
  }
  expect(STAFF_LINK_HOURS * 3600).toBe(STAFF_INVITATION_TTL_SEC);
});

test('почта none сообщает, что письма не доходят, остальные виды доходят', () => {
  expect(createMailer({ MAIL_TRANSPORT: 'none' }).delivers).toBe(false);
  expect(createMailer({ MAIL_TRANSPORT: 'console' }).delivers).toBe(true);
  expect(new MemoryMailer().delivers).toBe(true);
});
