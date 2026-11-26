import { expect, test } from 'vitest';
import { COMMON_PASSWORDS } from '@/modules/hdu/common-passwords';
import { isCommonPassword } from '@/modules/hdu/password-rules';

// Пароль сотрудника не из частых (аудит 23.11.2026, находка S11). Список встроенный: запросов в сеть нет.

test('частые пароли длиной от 12 знаков отклоняются, в том числе с цифрами и заменой букв', () => {
  for (const weak of [
    'Password12345',
    'password1234!',
    'P@ssw0rd2024!',
    'Passw0rd_2026',
    'qwertyuiop12',
    'Qwerty123456',
    'qwerty!@#$%^',
    'adminadmin12',
    'Administrator1',
    'Welcome12345!',
    'iloveyou1234',
    'Smartup2026Hub',
    'smartupsmartup',
    'SmartupSupport1',
    'letmein123456',
    'changeme12345',
    'Tashkent2026!',
    'parolparol123',
  ])
    expect(isCommonPassword(weak), weak).toBe(true);
});

test('последовательности, повторы и проходы по клавиатуре отклоняются', () => {
  for (const weak of [
    '123456789012',
    '012345678910',
    '987654321098',
    'aaaaaaaaaaaa',
    '111111111111',
    'abcabcabcabc',
    '121212121212',
    'abcdefghijkl',
    'qwertyasdfgh',
    'asdfghjklzxc',
    '1q2w3e4r5t6y',
    'qazwsxedcrfv',
    '1qaz2wsx3edc',
    'zxcvbnm12345',
    'йцукенгшщзхъ',
    'пароль123456',
  ])
    expect(isCommonPassword(weak), weak).toBe(true);
});

test('обычные длинные пароли и фразы проходят', () => {
  for (const fine of [
    'correct horse battery staple',
    'Zx7!kLm29#pQ',
    'osh-palov-2-kishi',
    'Мой кот ест плов в 7 утра',
    'tuman-ko‘prik-41-choy',
    'v9T$hq2LmX0z',
    'password-is-not-my-cat-Barsik',
    'smartup-otchet-kvartal-7Q',
    // Случайный пароль, в который попало частое слово, частым не становится.
    '93847!hub2817',
    '7!2#9$4&1@5%',
    'x9$admin#Lq2&vT',
    '48213-test-90517-kq',
  ])
    expect(isCommonPassword(fine), fine).toBe(false);
});

// Итоговая проверка волны 1, замечание F8: правило было уже своего названия.

test('частое слово с короткой добавкой отклоняется: MyPassword123, Summer2026!!, Company12345', () => {
  for (const weak of [
    'MyPassword123',
    'NewPassword1!',
    'Summer2026!!',
    'January2026!',
    'Company12345',
    'Qazwsx123456',
    'Aa123456789!',
    'Passw0rd!Passw0rd!',
    'aaaaaaaaaaab',
    '😀😀😀😀😀😀',
    'Password2026ab',
    'Alisher123456',
    'Dilnoza2026!!',
    'Security12345',
    'x111111111111',
  ])
    expect(isCommonPassword(weak), weak).toBe(true);
});

test('частое слово внутри длинного своего пароля его не портит', () => {
  for (const fine of [
    'Tashkent-83-57-12-99',
    'summer-rain-on-my-roof-41',
    'password-is-not-my-cat-Barsik',
    'my-company-moved-to-Chilanzar',
    'Aa1!Bb2@Cc3#Dd4$',
    'january-snow-7-kittens',
    'kW4#summer9Tz!2qLm',
  ])
    expect(isCommonPassword(fine), fine).toBe(false);
});

test('пароль в 128 знаков проверяется быстро', () => {
  const started = performance.now();
  for (const long of ['a1'.repeat(64), 'password'.repeat(16), 'qwertyuiop'.repeat(12) + 'zx!45678', 'x'.repeat(127) + 'y', '9z$K'.repeat(32)]) isCommonPassword(long);
  expect(performance.now() - started).toBeLessThan(200);
});

// ASVS 5.0.0, требование 6.2.4 (план подготовки M9, задача 1): пароль сверяется со списком из 3000 самых частых
// паролей, которые проходят правило длины портала (от 12 знаков). Правила выше пропускали 2472 из них.
test('3000 самых частых паролей от 12 знаков отклоняются, в любом регистре', () => {
  for (const weak of ['Mailcreated5240', 'leavemealone', 'sonyericsson', 'finalfantasy', 'LEAVEMEALONE', 'justinbieber', 'counterstrike', 'whosyourdaddy', 'iseedeadpeople', 'jamesbond007'])
    expect(isCommonPassword(weak), weak).toBe(true);
});

test('встроенный список частых паролей: 3000 строк от 12 знаков, строчными, без повторов', () => {
  const list = [...COMMON_PASSWORDS];
  expect(list).toHaveLength(3000);
  expect(new Set(list).size).toBe(3000);
  for (const entry of list) {
    expect(entry.length, entry).toBeGreaterThanOrEqual(12);
    expect(entry, entry).toBe(entry.toLowerCase());
  }
});
