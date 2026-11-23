import { expect, test } from 'vitest';
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
