import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Env, getEnv } from '@/env';
import { createResendMailer } from './resend';

// Модуль hdn, слой mailer: отправка писем (ТЗ 11.11, решение 0016).
//
// Четыре реализации одного интерфейса: none молчит, console и file нужны разработке и тестам
// и работают только на localhost (проверка в src/env.ts), resend отправляет по-настоящему (решение 0018).

export type MailKind = 'login-link' | 'confirm-email' | 'invitation';

export type MailMessage = { to: string; subject: string; text: string; kind: MailKind };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** none: письмо не уходит. В журнал идёт только вид письма: адрес и ссылка в журнале сервера не нужны. */
class SilentMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    console.info(`Письмо ${message.kind} не отправлено: почта выключена (MAIL_TRANSPORT=none)`);
  }
}

/** console: письмо целиком в журнал. Только для разработки на localhost. */
class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    console.info(`Письмо ${message.kind}\nКому: ${message.to}\nТема: ${message.subject}\n\n${message.text}\n`);
  }
}

/** file: каждое письмо отдельным файлом JSON. Его читают браузерные тесты. */
class FileMailer implements Mailer {
  constructor(private readonly dir: string) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID()}.json`;
    await writeFile(join(this.dir, name), JSON.stringify({ ...message, sentAt: new Date().toISOString() }, null, 2));
  }
}

/** Письма в памяти: для тестов. Письмо видно в sent сразу после вызова send. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

export function createMailer(env: Pick<Env, 'MAIL_TRANSPORT'> & Partial<Pick<Env, 'MAIL_FILE_DIR' | 'RESEND_API_KEY' | 'MAIL_FROM'>>): Mailer {
  switch (env.MAIL_TRANSPORT) {
    case 'resend':
      if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('RESEND_API_KEY и MAIL_FROM обязательны, а MAIL_TRANSPORT равен resend');
      return createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
    case 'console':
      return new ConsoleMailer();
    case 'file':
      if (!env.MAIL_FILE_DIR) throw new Error('MAIL_FILE_DIR не задана, а MAIL_TRANSPORT равен file');
      return new FileMailer(env.MAIL_FILE_DIR);
    default:
      return new SilentMailer();
  }
}

const shared = globalThis as typeof globalThis & { __hubMailer?: Mailer; __hubTestMailer?: Mailer | null };

/** Почта процесса по настройкам окружения. */
export function getMailer(): Mailer {
  if (shared.__hubTestMailer) return shared.__hubTestMailer;
  shared.__hubMailer ??= createMailer(getEnv());
  return shared.__hubMailer;
}

/** Подменяет почту в тестах. null возвращает почту по настройкам. */
export function setMailerForTests(mailer: Mailer | null): void {
  shared.__hubTestMailer = mailer;
}

/**
 * Отправляет письмо, не задерживая ответ: по времени ответа формы нельзя отличить существующий адрес
 * от несуществующего (FR-ID-06). Сбой отправки пишется в журнал без адреса и текста.
 */
export function queueMail(message: MailMessage): void {
  let sending: Promise<void>;
  try {
    sending = getMailer().send(message);
  } catch (error) {
    sending = Promise.reject(error);
  }
  sending.catch((error: unknown) => {
    console.error(`Письмо ${message.kind} не отправлено: ${error instanceof Error ? error.name : 'ошибка'}`);
  });
}
