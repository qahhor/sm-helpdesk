import { parseMailbox } from '../provider';

// Опознание отправителя по результату DMARC (FR-EM-03, поправка 101, угроза T32, решение 11 вехи M4).
// Заголовок Authentication-Results вписывает сервис приёма поверх письма. Отправитель может вписать свой такой же
// заголовок ниже, поэтому учитывается только самый верхний, и только если его добавил сервис приёма с
// идентификатором INBOUND_AUTHSERV_ID. Нет настройки, нет заголовка или он чужой: отправитель не опознан.

export function dmarcAligned(headers: [string, string][], fromAddress: string, authservId: string | undefined): boolean {
  if (!authservId) return false;
  const domain = parseMailbox(fromAddress)?.address.split('@')[1];
  if (!domain) return false;
  const results = headers.filter(([name]) => name.toLowerCase() === 'authentication-results').map(([, value]) => value);
  const top = results[0];
  if (!top) return false;
  // Второй заголовок с нашим идентификатором мог вписать отправитель, а порядок дублей в ответе API не гарантирован:
  // два таких заголовка считаются подделкой (итоговая проверка M4).
  const ours = results.filter((value) => (value.split(';')[0] ?? '').trim().split(/\s+/)[0]?.toLowerCase() === authservId.toLowerCase());
  if (ours.length > 1) return false;
  const [serv = '', ...parts] = top.split(';');
  if (serv.trim().split(/\s+/)[0]?.toLowerCase() !== authservId.toLowerCase()) return false;
  for (const part of parts) {
    const result = /\bdmarc\s*=\s*([a-z]+)/i.exec(part);
    if (!result) continue;
    const headerFrom = /\bheader\.from\s*=\s*([^\s;]+)/i.exec(part)?.[1]?.toLowerCase();
    return result[1]?.toLowerCase() === 'pass' && headerFrom === domain;
  }
  return false;
}

let override: string | null | undefined;

/** Тесты задают идентификатор сервиса приёма (null: не задан, undefined: из окружения). */
export function setInboundAuthservForTests(value: string | null | undefined): void {
  override = value;
}

/** Идентификатор сервиса приёма из окружения или из теста. */
export function inboundAuthservOf(env: { INBOUND_AUTHSERV_ID?: string }): string | undefined {
  if (override !== undefined) return override ?? undefined;
  return env.INBOUND_AUTHSERV_ID;
}
