import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { untrustedNoteText } from '@/modules/hdt/untrusted-text';
import { Markdown } from '@/ui/components/markdown';

// Текст непроверенного письма в заметке "Письмо на проверке" (аудит 23.11.2026, находка S12; итоговая проверка
// волны 1, F1). Заметку показывает разметка Markdown, поэтому проверяется итог на экране: ни одной ссылки.

const shown = (text: string) => renderToStaticMarkup(<Markdown text={untrustedNoteText(text, 'ru')} />);

test.each([
  'Войдите: https://evil.example/login',
  '[Войти в портал](https:\\//evil.example/login)',
  '[Войти](https\\://evil.example/login)',
  '[Войти](https:&#47;&#47;evil.example/login)',
  '[Войти](https&colon;//evil.example/login)',
  '[Войти][1]\n\n[1]: https:\\/\\/evil.example/login',
  '[Войти][1]\n\n[1]: <https:\\/\\/evil.example/login>',
  'Пишите <boss@evil.example>',
  '[Написать](mailto:boss@evil.example)',
  '<https://evil.example/login>',
  '[x](<https:\\//evil.example/a b>)',
  'www.evil.example/pay',
  '![картинка](https:\\//evil.example/track.png)',
  '[a](\\https://evil.example)',
  '[Войти](HTTPS:\\//EVIL.example)',
])('ссылка из непроверенного письма на экране не появляется: %s', (letter) => {
  const out = shown(letter);
  expect(out).not.toMatch(/<a[\s>]/i);
  expect(out).not.toMatch(/href=/i);
  expect(out).not.toMatch(/<img/i);
});

test('обычный текст письма остаётся читаемым, отметка об убранной ссылке видна', () => {
  const out = shown('Добрый день! Счёт №15 (от 12.11) не проходит: ошибка "нет прав". Подробности: https://docs.example/a_b?x=1');
  expect(out).toContain('Добрый день! Счёт №15 (от 12.11) не проходит: ошибка');
  expect(out).toContain('[ссылка убрана: docs.example]');
  expect(out).not.toContain('\\');
});

test('разметка из письма не оформляет текст заметки', () => {
  const out = shown('**срочно** `код` _важно_');
  expect(out).not.toMatch(/<strong|<code|<em/);
  expect(out).toContain('**срочно**');
});
