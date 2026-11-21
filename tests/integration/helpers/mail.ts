import { afterEach, beforeEach } from 'vitest';
import { type MailMessage } from '@/modules/hdn/api';
import { MemoryMailer, setMailerForTests } from '@/modules/hdn/testing';

// Письма интеграционных тестов складываются в память: по одному ящику на тест.

/** Подключает ящик в памяти к каждому тесту файла. */
export function memoryMailerPerTest(): { readonly mailer: MemoryMailer } {
  const box = { mailer: new MemoryMailer() };
  beforeEach(() => {
    box.mailer = new MemoryMailer();
    setMailerForTests(box.mailer);
  });
  afterEach(() => setMailerForTests(null));
  return box;
}

/** Ссылка из текста письма. */
export function linkFrom(mail: MailMessage | undefined): URL {
  const found = /https?:\/\/\S+/.exec(mail?.text ?? '');
  if (!found) throw new Error('В письме нет ссылки');
  return new URL(found[0]);
}

/** Токен из ссылки письма. */
export function tokenFrom(mail: MailMessage | undefined): string {
  return linkFrom(mail).searchParams.get('token') ?? '';
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
