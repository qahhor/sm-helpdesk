import { parseMailbox } from '../provider';

// Автоответы и недоставка (FR-EM-07, решение 17 вехи M4): такие письма сохраняются, но не создают обращений
// и не получают ответов. Признаки по заголовкам, отправителю и теме.

const BOUNCE_SENDERS = new Set(['mailer-daemon', 'postmaster']);
const BOUNCE_SUBJECT = /^(?:undeliverable|undelivered mail|delivery status notification|mail delivery failed|returned mail|delivery failure|недоставленное сообщение|не удалось доставить|сообщение не доставлено|xat yetkazilmadi)\b/i;
const AUTO_SUBJECT = /^(?:automatic reply|auto-?reply|autoreply|out of office|ooo\b|автоответ|автоматический ответ|вне офиса|avtomatik javob|ofisda emasman)/i;
const AUTO_HEADERS = ['x-autoreply', 'x-autorespond', 'x-autoresponder', 'x-auto-response-suppress'];
const AUTO_PRECEDENCE = new Set(['bulk', 'junk', 'list', 'auto_reply']);

export function classifyAuto(headers: [string, string][], from: string, subject: string): 'auto' | 'bounce' | null {
  const map = new Map<string, string>();
  for (const [name, value] of headers) if (!map.has(name.toLowerCase())) map.set(name.toLowerCase(), value.trim());
  const local = (parseMailbox(from)?.address ?? from.toLowerCase()).split('@')[0] ?? '';
  const topic = subject.trim();
  if (BOUNCE_SENDERS.has(local) || /^multipart\/report\b/i.test(map.get('content-type') ?? '') || BOUNCE_SUBJECT.test(topic)) return 'bounce';
  const autoSubmitted = map.get('auto-submitted');
  if (autoSubmitted !== undefined && autoSubmitted.toLowerCase() !== 'no') return 'auto';
  if (AUTO_HEADERS.some((name) => map.has(name))) return 'auto';
  if (AUTO_PRECEDENCE.has((map.get('precedence') ?? '').toLowerCase())) return 'auto';
  if (AUTO_SUBJECT.test(topic)) return 'auto';
  return null;
}
