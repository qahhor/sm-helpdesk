import { parseMailbox } from '../provider';

// Опознание отправителя по результату DMARC (FR-EM-03, поправка 101, угроза T32, решение 11 вехи M4).
// Заголовок Authentication-Results вписывает сервис приёма поверх письма. Отправитель может вписать свой такой же
// заголовок ниже, поэтому учитывается только самый верхний, и только если его добавил сервис приёма с
// идентификатором INBOUND_AUTHSERV_ID. Нет настройки, нет заголовка или он чужой: отправитель не опознан.

export function dmarcAligned(headers: [string, string][], fromAddress: string, authservId: string | undefined): boolean {
  if (!authservId) return false;
  const domain = parseMailbox(fromAddress)?.address.split('@')[1];
  if (!domain) return false;
  const top = headers.find(([name]) => name.toLowerCase() === 'authentication-results')?.[1];
  if (!top) return false;
  const [serv = '', ...results] = top.split(';');
  if (serv.trim().split(/\s+/)[0]?.toLowerCase() !== authservId.toLowerCase()) return false;
  for (const part of results) {
    const result = /\bdmarc\s*=\s*([a-z]+)/i.exec(part);
    if (!result) continue;
    const headerFrom = /\bheader\.from\s*=\s*([^\s;]+)/i.exec(part)?.[1]?.toLowerCase();
    return result[1]?.toLowerCase() === 'pass' && headerFrom === domain;
  }
  return false;
}
