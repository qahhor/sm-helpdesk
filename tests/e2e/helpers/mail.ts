import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { MAIL_DIR } from '../../../playwright.config';

// Письма браузерных тестов: приложение пишет каждое письмо файлом JSON в MAIL_DIR (MAIL_TRANSPORT=file).

type StoredMail = { to: string; kind: string; subject: string; text: string; sentAt: string };

function latest(to: string, kind: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(MAIL_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return undefined;
  }
  // Имя файла начинается со времени отправки: последнее письмо в конце списка.
  for (const name of files.sort().reverse()) {
    const mail = JSON.parse(readFileSync(join(MAIL_DIR, name), 'utf8')) as StoredMail;
    if (mail.to === to && mail.kind === kind) return /https?:\/\/\S+/.exec(mail.text)?.[0];
  }
  return undefined;
}

/** Ссылка из последнего письма данного вида на адрес. Ждёт письмо до 10 секунд: отправка не задерживает ответ формы. */
export async function mailLink(to: string, kind: 'login-link' | 'confirm-email' | 'invitation', notThis?: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(() => {
      link = latest(to, kind);
      return link !== undefined && link !== notThis;
    }, { timeout: 10_000 })
    .toBe(true);
  return link as string;
}
