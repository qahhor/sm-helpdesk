import { expect, test } from 'vitest';
import { parseGlossary, pretranslateMessages } from '@/modules/hda/api/ui-translate';
import { StubAiClient } from '@/modules/hda/client/stub';

// Предварительный перевод файла нового языка (FR-I18N-10; волна 7, T4; решение 0161). На заглушке: проверяется, что
// в модель уходят только строки интерфейса и глоссарий, что устройство файла сохраняется, а строка, в которой
// модель потеряла подстановку или разметку, остаётся на исходном языке и названа в списке для человека.

const SOURCE = {
  common: { save: 'Сохранить', hello: 'Здравствуйте, {name}!' },
  tickets: { count: '{count, plural, one {# обращение} few {# обращения} other {# обращений}}', link: 'Откройте <link>заказ</link>' },
};
const GLOSSARY = 'ru,uz,en,note\nзаказ,buyurtma,order,"термин бренда"\nторговая точка,savdo nuqtasi,outlet,';

test('глоссарий: строки CSV с кавычками, пустые строки пропускаются', () => {
  expect(parseGlossary(GLOSSARY)).toEqual([
    { ru: 'заказ', uz: 'buyurtma', en: 'order' },
    { ru: 'торговая точка', uz: 'savdo nuqtasi', en: 'outlet' },
  ]);
  expect(parseGlossary('ru,uz,en,note\n"a, b","c ""d""",e,\n\n')).toEqual([{ ru: 'a, b', uz: 'c "d"', en: 'e' }]);
});

test('в модель уходят только строки интерфейса и глоссарий; файл нового языка повторяет устройство исходного', async () => {
  const client = new StubAiClient((call) => ({
    segments: [...call.data.matchAll(/<segment id="([^"]+)">([\s\S]*?)<\/segment>/g)].map((m) => ({ id: m[1], text: `KK:${m[2]}` })),
  }));
  const result = await pretranslateMessages({ source: SOURCE, from: 'ru', to: 'kk', toName: 'казахский', glossary: parseGlossary(GLOSSARY), client, model: 'model-x', batchSize: 3 });
  expect(result.messages).toEqual({
    common: { save: 'KK:Сохранить', hello: 'KK:Здравствуйте, {name}!' },
    tickets: { count: 'KK:{count, plural, one {# обращение} few {# обращения} other {# обращений}}', link: 'KK:Откройте <link>заказ</link>' },
  });
  expect(result).toMatchObject({ total: 4, translated: 4, kept: [] });
  // Две пачки по три строки: в данных только тексты строк с номерами, ключей и пути файла нет.
  expect(client.calls).toHaveLength(2);
  const sent = client.calls.map((call) => call.data).join('\n');
  for (const text of ['Сохранить', 'Здравствуйте, {name}!', 'Откройте &lt;link&gt;заказ&lt;/link&gt;']) expect(sent).toContain(text);
  for (const leak of ['common.save', 'tickets.count', 'messages/']) expect(sent).not.toContain(leak);
  expect(client.calls[0]!.model).toBe('model-x');
  // Глоссарий лежит в правилах: термины исходного языка и английского.
  expect(client.calls[0]!.system).toContain('заказ = order');
  expect(client.calls[0]!.system).toContain('казахский');
});

test('потерянная подстановка, разметка или множественное число: строка остаётся исходной и названа в списке', async () => {
  const client = new StubAiClient((call) => ({
    segments: [...call.data.matchAll(/<segment id="([^"]+)">([\s\S]*?)<\/segment>/g)].map((m) => ({
      id: m[1],
      text: m[2]!.includes('{name}') ? 'Сәлем, {аты}!' : m[2]!.includes('plural') ? '{count} өтініш' : m[2]!.includes('link') ? 'Тапсырысты ашыңыз' : 'Сақтау',
    })),
  }));
  const result = await pretranslateMessages({ source: SOURCE, from: 'ru', to: 'kk', toName: 'казахский', glossary: [], client, model: 'm' });
  expect(result.messages).toEqual({ common: { save: 'Сақтау', hello: SOURCE.common.hello }, tickets: SOURCE.tickets });
  expect(result.kept.sort()).toEqual(['common.hello', 'tickets.count', 'tickets.link']);
  expect(result.translated).toBe(1);
});

test('лишние, чужие и пропущенные куски ответа не меняют файл: пропущенная строка остаётся исходной', async () => {
  const client = new StubAiClient(() => ({ segments: [{ id: '0', text: 'Сақтау' }, { id: '999', text: 'чужая строка' }, { id: '__proto__', text: 'x' }] }));
  const result = await pretranslateMessages({ source: SOURCE, from: 'ru', to: 'kk', toName: 'казахский', glossary: [], client, model: 'm' });
  expect(result.messages).toEqual({ common: { save: 'Сақтау', hello: SOURCE.common.hello }, tickets: SOURCE.tickets });
  expect(result.kept).toHaveLength(3);
  expect(JSON.stringify(result.messages)).not.toContain('чужая строка');
});
