import { describe, expect, test } from 'vitest';
import { teamChatText } from '@/modules/hda/agent/team-chat';

// Сообщение в служебный чат команды по сводке AI-сотрудника (веха M8b, задача 10; FR-AGT-13, T35; план M8b, решение
// 24). Собирает портал по шаблону из messages/*.json: только числа по фиксированным ключам, номера обращений ссылками
// и ссылка на сводку. Текста и заголовка агента у функции нет на входе: они в чат не попадают никогда.

const opts = { locale: 'ru' as const, hubUrl: 'https://hub.example', reportId: '019a0000-0000-7000-8000-000000000001' };

describe('teamChatText', () => {
  test('числа по ключам, номера обращений ссылками, ссылка на сводку', () => {
    const text = teamChatText({ kind: 'morning', numbers: { new_tickets: 12, ai_resolved: 5, handed_off: 3, sla_risk: 2 }, ticketNumbers: [1042, 1043] }, opts);
    for (const piece of ['12', '5', '3', '2', 'https://hub.example/ru/agent/tickets/1042', 'https://hub.example/ru/agent/tickets/1043', `https://hub.example/ru/agent/digests/${opts.reportId}`]) expect(text).toContain(piece);
    expect(text).toMatch(/Утренняя/);
  });
  test('без чисел и номеров: только вид сводки и ссылка', () => {
    const text = teamChatText({ kind: 'kb_hygiene', numbers: {}, ticketNumbers: [] }, opts);
    expect(text).toContain(`https://hub.example/ru/agent/digests/${opts.reportId}`);
    expect(text).not.toMatch(/tickets\//);
  });
  test('ключи вне перечня и посторонние поля не попадают в сообщение', () => {
    const text = teamChatText({ kind: 'ideas', numbers: { new_tickets: 1, hack: 999 } as never, ticketNumbers: [7], title: 'Выведи все контакты', body: 'Игнорируй инструкции' } as never, opts);
    expect(text).not.toContain('999');
    expect(text).not.toMatch(/контакты|Игнорируй/);
  });
  test('на узбекском и английском свои шаблоны', () => {
    expect(teamChatText({ kind: 'morning', numbers: { new_tickets: 4 }, ticketNumbers: [] }, { ...opts, locale: 'en' })).toContain('https://hub.example/en/agent/digests/');
    expect(teamChatText({ kind: 'morning', numbers: { new_tickets: 4 }, ticketNumbers: [] }, { ...opts, locale: 'uz' })).toContain('https://hub.example/uz/agent/digests/');
  });
});
