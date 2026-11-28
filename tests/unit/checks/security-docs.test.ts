import { expect, test } from 'vitest';
import { hostsInSource, logCodesInSource, securityDocsCheck, securityDocsProblems, urlVarsInEnvExample } from '../../../scripts/checks/security-docs.mjs';

// Документы безопасности (план M9, задача 6; ASVS V13.1.1, V16.3.3): перечень внешних узлов в docs/security/policies.md
// совпадает с адресами в исходниках и переменными адресов .env.example, перечень событий безопасности совпадает с
// кодами журнала аудита и журнала процесса (auth.*, authz.*, session.*, staff.*, agent.token*, agent.run_token*).

const POLICIES = [
  '# Политики',
  '## Внешние узлы',
  '| Узел | Зачем |',
  '|---|---|',
  '| `api.resend.com` | письма |',
  '| `TELEGRAM_API_URL` | бот |',
  '## События безопасности',
  '| Код | Что |',
  '|---|---|',
  '| `staff.signed_in` | вход |',
  '| `authz.denied` | отказ |',
  '## Другое',
  '`api.example.com` здесь не перечень',
].join('\n');

const SOURCES = { hosts: ['api.resend.com'], urlVars: ['TELEGRAM_API_URL'], codes: ['staff.signed_in', 'authz.denied', 'ticket.created'] };

test('совпадающие перечни проходят', () => {
  expect(securityDocsProblems(POLICIES, SOURCES)).toEqual([]);
});

test('внешний узел или переменная адреса без строки перечня: ошибка', () => {
  expect(securityDocsProblems(POLICIES, { ...SOURCES, hosts: [...SOURCES.hosts, 'api.anthropic.com'], urlVars: [...SOURCES.urlVars, 'AGENT_WEBHOOK_URL'] })).toEqual([
    'внешний узел api.anthropic.com не назван в разделе "Внешние узлы"',
    'переменная адреса AGENT_WEBHOOK_URL не названа в разделе "Внешние узлы"',
  ]);
});

test('код безопасности без строки перечня и лишний пункт перечня: ошибка; прочие коды не нужны', () => {
  expect(securityDocsProblems(POLICIES, { ...SOURCES, codes: ['staff.signed_in', 'session.revoked_bulk', 'agent.run_token_issued', 'ticket.created'] })).toEqual([
    'код session.revoked_bulk не назван в разделе "События безопасности"',
    'код agent.run_token_issued не назван в разделе "События безопасности"',
    'в разделе "События безопасности" код authz.denied, которого нет в исходниках',
  ]);
  const extraHost = POLICIES.replace('| `TELEGRAM_API_URL` | бот |', '| `TELEGRAM_API_URL` | бот |\n| `old.example.org` | был |');
  expect(securityDocsProblems(extraHost, SOURCES)).toEqual(['в разделе "Внешние узлы" узел old.example.org, которого нет в исходниках и .env.example']);
});

test('без раздела: ошибка', () => {
  expect(securityDocsProblems('# Пусто', SOURCES)).toEqual(['нет раздела "Внешние узлы"', 'нет раздела "События безопасности"']);
});

test('сбор из исходников: адреса https, переменные адресов и коды журналов', () => {
  expect(hostsInSource("const API = 'https://api.resend.com/emails'; // https://docs.example.com\nconst x = `https://${host}`;")).toEqual(['api.resend.com']);
  expect(urlVarsInEnvExample('HUB_URL=http://localhost:3000\n# TYPESENSE_URL=http://typesense:8108\nCLAMAV_HOST=clamav\nSECRET=1')).toEqual(['HUB_URL', 'TYPESENSE_URL', 'CLAMAV_HOST']);
  expect(logCodesInSource("logEvent('warn', 'authz.denied', {});\nlogEvent(ok ? 'info' : 'warn', ok ? 'auth.ok' : 'auth.fail', {});\nconst y = 'staff.not_a_log';")).toEqual(['authz.denied', 'auth.ok', 'auth.fail']);
});

test('настоящий docs/security/policies.md сходится с исходниками', () => {
  expect(securityDocsCheck()).toEqual([]);
});
