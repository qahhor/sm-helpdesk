import { describe, expect, test, vi } from 'vitest';
import { acceptHostMessage, cleanHints, parseHostMessage, resolveHostOrigin, sendToHost } from '@/ui/widget/protocol';

// Протокол postMessage со стороны страницы виджета (план M6, задача 4, решение 8; раздел "На что смотреть", пункт 5).
// Пакета jsdom в проекте нет, а новые пакеты не ставятся: окна и события здесь простые объекты с теми же полями,
// что у MessageEvent и Window. В настоящем браузере протокол проверяет tests/e2e/widget-report.spec.ts.

const HOST = 'https://smartup.example';
const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';

describe('адрес хозяина', () => {
  const allowed = [HOST, 'https://web.smartup.example'];

  test('берётся из location.ancestorOrigins и должен быть в списке сервера', () => {
    expect(resolveHostOrigin({ allowed, ancestorOrigins: [HOST], param: null, framed: true })).toBe(HOST);
    expect(resolveHostOrigin({ allowed, ancestorOrigins: ['https://evil.example'], param: null, framed: true })).toBeNull();
  });

  test('параметр загрузчика не подменяет адрес, который назвал браузер', () => {
    expect(resolveHostOrigin({ allowed, ancestorOrigins: ['https://evil.example'], param: HOST, framed: true })).toBeNull();
    expect(resolveHostOrigin({ allowed, ancestorOrigins: [HOST], param: 'https://web.smartup.example', framed: true })).toBeNull();
  });

  test('без ancestorOrigins (Firefox) берётся параметр загрузчика, сверенный со списком', () => {
    expect(resolveHostOrigin({ allowed, ancestorOrigins: undefined, param: `${HOST}/some/path`, framed: true })).toBe(HOST);
    expect(resolveHostOrigin({ allowed, ancestorOrigins: [], param: 'https://evil.example', framed: true })).toBeNull();
    expect(resolveHostOrigin({ allowed, ancestorOrigins: undefined, param: null, framed: true })).toBeNull();
    expect(resolveHostOrigin({ allowed, ancestorOrigins: undefined, param: 'not a url', framed: true })).toBeNull();
  });

  test('страница не во фрейме и пустой список сервера: адреса нет', () => {
    expect(resolveHostOrigin({ allowed, ancestorOrigins: [HOST], param: HOST, framed: false })).toBeNull();
    expect(resolveHostOrigin({ allowed: [], ancestorOrigins: [HOST], param: HOST, framed: true })).toBeNull();
  });
});

describe('входящие сообщения', () => {
  const parent = { postMessage: vi.fn() };
  const init = { hub: 1, type: 'init', token: TOKEN, hints: { module: 'orders', errorText: 'ORA-20001: нет остатка' }, theme: 'dark', locale: 'ru' };

  test('сообщение окна-родителя с проверенного адреса принимается', () => {
    expect(acceptHostMessage({ origin: HOST, source: parent, data: init }, { parent, hostOrigin: HOST })).toEqual({
      type: 'init',
      token: TOKEN,
      hints: { module: 'orders', errorText: 'ORA-20001: нет остатка' },
      theme: 'dark',
    });
  });

  test('чужой адрес отбрасывается', () => {
    expect(acceptHostMessage({ origin: 'https://evil.example', source: parent, data: init }, { parent, hostOrigin: HOST })).toBeNull();
    expect(acceptHostMessage({ origin: 'null', source: parent, data: init }, { parent, hostOrigin: HOST })).toBeNull();
  });

  test('сообщение из другого окна с верного адреса отбрасывается', () => {
    const other = { postMessage: vi.fn() };
    expect(acceptHostMessage({ origin: HOST, source: other, data: init }, { parent, hostOrigin: HOST })).toBeNull();
    expect(acceptHostMessage({ origin: HOST, source: null, data: init }, { parent, hostOrigin: HOST })).toBeNull();
  });

  test('без проверенного адреса хозяина не принимается ничего', () => {
    expect(acceptHostMessage({ origin: HOST, source: parent, data: init }, { parent, hostOrigin: null })).toBeNull();
  });

  test('неверная схема, другая версия и неизвестный тип отбрасываются', () => {
    for (const data of [
      null,
      'init',
      { ...init, hub: 2 },
      { ...init, hub: '1' },
      { hub: 1, type: 'steal-token' },
      { hub: 1, type: 'token' },
      { hub: 1, type: 'token', token: '' },
      { hub: 1, type: 'token', token: 'a b' },
      { hub: 1, type: 'token', token: 'x'.repeat(9000) },
      { hub: 1, type: 'init', token: 42 },
    ])
      expect(parseHostMessage(data), JSON.stringify(data)?.slice(0, 80)).toBeNull();
  });

  test('неверная тема не принимается, сообщение остаётся', () => {
    expect(parseHostMessage({ ...init, theme: 'red' })).toMatchObject({ type: 'init', theme: null });
  });
});

describe('подсказки (решение 11)', () => {
  test('каждое поле проверяется отдельно, неверное отбрасывается', () => {
    expect(
      cleanHints({
        module: 'orders.list',
        form: 'bad form<script>',
        appVersion: '5.12.0',
        errorCode: 'ORA-20001',
        errorText: '<img src=x onerror=alert(1)> javascript:alert(1)',
        orgId: 'другая организация',
      }),
    ).toEqual({ module: 'orders.list', appVersion: '5.12.0', errorCode: 'ORA-20001', errorText: '<img src=x onerror=alert(1)> javascript:alert(1)' });
  });

  test('пределы длины и управляющие знаки', () => {
    expect(cleanHints({ module: 'm'.repeat(65), appVersion: 'v'.repeat(33), errorCode: 'c'.repeat(65), errorText: 't'.repeat(2001) })).toEqual({});
    expect(cleanHints({ errorText: 'a\u0000b\u0007c' })).toEqual({ errorText: 'abc' });
    expect(cleanHints(null)).toEqual({});
    expect(cleanHints(['orders'])).toEqual({});
  });
});

describe('исходящие сообщения', () => {
  test('уходят только на точный адрес хозяина', () => {
    const parent = { postMessage: vi.fn() };
    expect(sendToHost(parent, HOST, { type: 'ticket-created', number: 1070 })).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith({ hub: 1, type: 'ticket-created', number: 1070 }, HOST);
  });

  test('без проверенного адреса и на адрес "*" не уходит ничего', () => {
    const parent = { postMessage: vi.fn() };
    expect(sendToHost(parent, null, { type: 'ready' })).toBe(false);
    expect(sendToHost(parent, '*', { type: 'need-token' })).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});
