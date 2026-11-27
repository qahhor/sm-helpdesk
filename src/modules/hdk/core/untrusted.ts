import 'server-only';
import { createHash } from 'node:crypto';
import { findCommands, findInText, solutionBodyText, type UntrustedFinding } from '../checks';
import type { SolutionDoc } from '../doc-schema';

// Модуль hdk, слой core: находки недоверенного текста решения из кандидата (план M5c, задача 10, решение 30; FR-CAND-09,
// угроза T33). Телефон, почта, команды и код из текста модели по переписке клиента публикуются только после отметки
// каждой находки "Проверено". Отметки привязаны к отпечатку текста: изменённый текст их сбрасывает.

export type UntrustedConfirmed = { textHash: string; fingerprints: string[] };

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Отпечаток текста версии: заголовок и документ. */
export const untrustedTextHash = (content: { title: string; doc: SolutionDoc }): string => sha(`${content.title}\n${JSON.stringify(content.doc)}`);

/** Находки телефона, почты, команд и кода в заголовке и тексте решения, по одной на вид и текст. */
export function untrustedFindings(content: { title: string; doc: SolutionDoc }): UntrustedFinding[] {
  const text = `${content.title}\n${solutionBodyText(content.doc)}`;
  const hits = [
    ...findInText(text).flatMap((hit) => (hit.kind === 'phone' || hit.kind === 'email' ? [{ kind: hit.kind, text: hit.text }] : [])),
    ...findCommands(text),
  ];
  const seen = new Set<string>();
  return hits.flatMap((hit) => {
    const fingerprint = sha(`${hit.kind}\n${hit.text}`).slice(0, 32);
    if (seen.has(fingerprint)) return [];
    seen.add(fingerprint);
    return [{ kind: hit.kind as UntrustedFinding['kind'], text: hit.text, fingerprint }];
  });
}

/** Отметки, которые действуют для этого текста: отпечаток текста совпал. */
export function confirmedFor(content: { title: string; doc: SolutionDoc }, stored: UntrustedConfirmed | null): Set<string> {
  return new Set(stored && stored.textHash === untrustedTextHash(content) ? stored.fingerprints : []);
}
