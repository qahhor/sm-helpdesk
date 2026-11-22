import { expect, test } from 'vitest';
import { dmarcAligned } from '@/modules/hdn/inbound/auth-results';

// Отправитель опознан только при DMARC с совпадением домена (FR-EM-03, поправка 101, угроза T32, решение 11):
// учитывается только верхний заголовок Authentication-Results, и только если его добавил сервис приёма.

const OURS = 'inbound.example.test';
const ar = (value: string): [string, string] => ['Authentication-Results', value];

test('dmarc=pass с совпадением домена: true; pass для другого домена, fail, заголовок без нужного authserv-id, нижний заголовок, вписанный отправителем: false; переменная не задана: false', () => {
  const pass = ar(`${OURS}; spf=pass smtp.mailfrom=example.uz; dkim=pass header.d=example.uz; dmarc=pass (p=none) header.from=example.uz`);
  expect(dmarcAligned([pass], 'ivan@example.uz', OURS)).toBe(true);
  expect(dmarcAligned([pass], 'Ivan@Example.UZ', OURS)).toBe(true);
  // Совпадение регистра идентификатора сервиса не важно.
  expect(dmarcAligned([pass], 'ivan@example.uz', OURS.toUpperCase())).toBe(true);
  // DMARC прошёл для другого домена.
  expect(dmarcAligned([ar(`${OURS}; dmarc=pass header.from=other.uz`)], 'ivan@example.uz', OURS)).toBe(false);
  // DMARC не прошёл.
  expect(dmarcAligned([ar(`${OURS}; dmarc=fail header.from=example.uz`)], 'ivan@example.uz', OURS)).toBe(false);
  expect(dmarcAligned([ar(`${OURS}; dmarc=none header.from=example.uz`)], 'ivan@example.uz', OURS)).toBe(false);
  // Заголовок добавил не наш сервис приёма.
  expect(dmarcAligned([ar('mx.evil.example; dmarc=pass header.from=example.uz')], 'ivan@example.uz', OURS)).toBe(false);
  // Наш заголовок с fail сверху, ниже вписанный отправителем "pass" с тем же идентификатором: не принимается.
  expect(dmarcAligned([ar(`${OURS}; dmarc=fail header.from=example.uz`), pass], 'ivan@example.uz', OURS)).toBe(false);
  // Сверху чужой заголовок: верхний не наш, нижним не доверяем.
  expect(dmarcAligned([ar('mx.evil.example; dmarc=pass header.from=example.uz'), pass], 'ivan@example.uz', OURS)).toBe(false);
  // Переменная не задана, заголовков нет, адрес без домена.
  expect(dmarcAligned([pass], 'ivan@example.uz', undefined)).toBe(false);
  expect(dmarcAligned([], 'ivan@example.uz', OURS)).toBe(false);
  expect(dmarcAligned([pass], 'не адрес', OURS)).toBe(false);
  // Имя заголовка в другом регистре.
  expect(dmarcAligned([['authentication-results', pass[1]]], 'ivan@example.uz', OURS)).toBe(true);
});

test('два заголовка с нашим authserv-id: не опознан, даже если верхний говорит pass (итоговая проверка M4, I12)', () => {
  // Сервис приёма вписывает свой заголовок сверху; второй такой же ниже мог вписать отправитель. Порядок дублей в
  // ответе API не гарантирован, поэтому два заголовка с нашим идентификатором считаются подделкой.
  const headers = [ar(`${OURS}; dmarc=pass header.from=client.uz`), ar(`${OURS}; dmarc=pass header.from=client.uz`)];
  expect(dmarcAligned(headers, 'boss@client.uz', OURS)).toBe(false);
  expect(dmarcAligned([ar(`${OURS}; dmarc=pass header.from=client.uz`), ar('other.example; dmarc=pass header.from=client.uz')], 'boss@client.uz', OURS)).toBe(true);
});
