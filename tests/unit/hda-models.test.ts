import { expect, test, vi } from 'vitest';
import { AI_MODELS, AI_PURPOSES, modelForPurpose } from '@/modules/hda/pref';
import { costUsd, inputHash } from '@/modules/hda/util';

// Модели по назначению и цена по модели (план M5b, задача 1, решения 1, 2, 12).

vi.mock('@/lib/log', () => ({ logEvent: vi.fn() }));

test('по умолчанию: первая линия на Sonnet, остальные цели на Haiku, Opus нигде', () => {
  expect(AI_MODELS).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  for (const purpose of AI_PURPOSES) expect(modelForPurpose(purpose, {}, {})).toBe(purpose === 'first_line' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5');
});

test('окружение задаёт модели уровней по умолчанию, настройка сильнее; модель вне списка в настройке не принимается', () => {
  expect(modelForPurpose('first_line', {}, { quality: 'env-quality' })).toBe('env-quality');
  expect(modelForPurpose('triage', {}, { fast: 'env-fast' })).toBe('env-fast');
  expect(modelForPurpose('first_line', { first_line: 'claude-opus-5-5' }, { quality: 'env-quality' })).toBe('claude-opus-5-5');
  expect(modelForPurpose('first_line', { first_line: 'gpt-x' }, {})).toBe('claude-sonnet-5-5');
});

test('цена по модели из ответа: Sonnet 2 и 10, Haiku 0,10 и 0,50, Opus 4 и 20 долларов за миллион', () => {
  const usage = { inputTokens: 3000, outputTokens: 400 };
  expect(costUsd('claude-sonnet-5-5', usage)).toBe(0.01);
  expect(costUsd('claude-haiku-5-5', usage)).toBe(0.0005);
  expect(costUsd('claude-opus-5-5', usage)).toBe(0.02);
  // Ответ модели с датой версии считается по своей модели.
  expect(costUsd('claude-haiku-5-5-20261101', usage)).toBe(0.0005);
});

test('неизвестная модель в ответе: цена самой дорогой из списка и предупреждение в журнал', async () => {
  const { logEvent } = await import('@/lib/log');
  expect(costUsd('claude-sonnet-5', { inputTokens: 3000, outputTokens: 400 })).toBe(0.02);
  expect(logEvent).toHaveBeenCalledWith('warn', 'ai.unknown_model_price', expect.objectContaining({ model: 'claude-sonnet-5' }));
});

test('хеш входа (решение 12): HMAC без текста, пробелы и регистр не меняют его, другой текст меняет', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const a = inputHash('Документ не проводится', key);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).not.toContain('Документ');
  expect(inputHash('  документ   НЕ проводится ', key)).toBe(a);
  expect(inputHash('Документ не печатается', key)).not.toBe(a);
  expect(inputHash('Документ не проводится', Buffer.alloc(32, 8).toString('base64'))).not.toBe(a);
});
