// Модуль hdn: короткое сообщение в служебный чат дежурных о P1 (FR-SLA-07, решение 8 вехи M4).
// Номер, приоритет, организация и ссылка, без текста клиента (раздел 14.6 ТЗ). Чат служебный, язык русский.

import { noLinks } from '../mail/sanitize';

export function oncallTelegramText(payload: Record<string, unknown>, hubUrl: string): string {
  const number = typeof payload.number === 'number' ? payload.number : 0;
  const org = typeof payload.orgName === 'string' ? noLinks(payload.orgName, 100) : '';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? `${hubUrl}/ru${payload.url}` : `${hubUrl}/ru/agent/tickets/${number}`;
  return `P1: новое срочное обращение SUP-${number}${org ? `, ${org}` : ''}\n${url}`;
}
