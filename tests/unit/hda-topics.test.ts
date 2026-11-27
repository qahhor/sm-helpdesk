import { expect, test } from 'vitest';
import { asksHuman, matchRestrictedTopic, RESTRICTED_TOPICS, RESTRICTED_TOPICS_DEFAULT, skeleton } from '@/modules/hda/topics';

// Обязательные темы и просьба позвать человека ищутся кодом (FR-AI-06, UX-B-07; план M5b, задача 2, решение 17):
// на трёх языках, узбекский в обеих письменностях, с приведением апострофов, против обходов разрядкой, сменой
// письменности и невидимыми знаками. Совпадение ведёт к передаче сотруднику, что бы ни ответила модель.

const topic = (text: string) => matchRestrictedTopic(text, RESTRICTED_TOPICS_DEFAULT);

test('семь тем FR-AI-06', () => {
  expect([...RESTRICTED_TOPICS]).toEqual(['payments', 'contract', 'complaint', 'data_change', 'access', 'security', 'legal']);
  for (const t of RESTRICTED_TOPICS) for (const lang of ['ru', 'uz', 'en'] as const) expect(RESTRICTED_TOPICS_DEFAULT[t][lang].length, `${t} ${lang}`).toBeGreaterThan(0);
});

test.each([
  ['payments', 'ru', 'Не прошла оплата за подписку, деньги списали'],
  ['payments', 'uz', "To'lov o'tmadi, pul yechildi"],
  ['payments', 'uz-cyrl', 'Тўлов ўтмади, пул ечилди'],
  ['payments', 'en', 'We were charged twice for the payment'],
  ['contract', 'ru', 'Хотим расторгнуть договор'],
  ['contract', 'uz', 'Shartnomani bekor qilmoqchimiz'],
  ['contract', 'uz-cyrl', 'Шартномани бекор қилмоқчимиз'],
  ['contract', 'en', 'We want to terminate the contract'],
  ['complaint', 'ru', 'Это жалоба на работу поддержки'],
  ['complaint', 'uz', "Qo'llab-quvvatlash ustidan shikoyat"],
  ['complaint', 'uz-cyrl', 'Қўллаб-қувватлаш устидан шикоят'],
  ['complaint', 'en', 'I want to file a complaint'],
  ['data_change', 'ru', 'Удалите все документы за прошлый год'],
  ['data_change', 'uz', "Barcha hujjatlarni o'chirib tashlang"],
  ['data_change', 'uz-cyrl', 'Барча ҳужжатларни ўчириб ташланг'],
  ['data_change', 'en', 'Please delete all orders from last year'],
  ['access', 'ru', 'Дайте мне права администратора'],
  ['access', 'uz', 'Menga administrator huquqini bering'],
  ['access', 'uz-cyrl', 'Менга администратор ҳуқуқини беринг'],
  ['access', 'en', 'Grant me admin access to the account'],
  ['security', 'ru', 'Похоже, нас взломали, утечка пароля'],
  ['security', 'uz', 'Bizni buzishdi, parol oshkor bo\'ldi'],
  ['security', 'uz-cyrl', 'Бизни бузишди, парол ошкор бўлди'],
  ['security', 'en', 'Our account was hacked'],
  ['legal', 'ru', 'Передадим дело в суд и юристам'],
  ['legal', 'uz', 'Ishni sudga beramiz'],
  ['legal', 'uz-cyrl', 'Ишни судга берамиз'],
  ['legal', 'en', 'Our lawyer will contact you about the lawsuit'],
])('%s %s', (expected, _lang, text) => {
  expect(topic(text)).toBe(expected);
});

test.each([
  ['разрядка пробелами', 'Не прошла о п л а т а, верните'],
  ['разрядка точками и дефисами', 'Не прошла о.п.л.а.т.а и д-о-г-о-в-о-р'],
  ['латинские буквы внутри кириллицы', 'Не прошла oплaтa'],
  ['кириллица внутри латиницы', "Тo'lov o'tmadi"],
  ['апостроф ʻ', 'Toʻlov oʻtmadi'],
  ['апостроф ʼ и ‘', 'To’lov o‘tmadi'],
  ['невидимые знаки между буквами', 'Не прошла оп​ла⁠та'],
  ['знаки тегов Юникода', 'Не прошла опл\u{E0041}ата'],
  ['полноширинные буквы', 'ｐａｙｍｅｎｔ failed'],
  ['заглавные', 'НЕ ПРОШЛА ОПЛАТА'],
])('обход: %s', (_name, text) => {
  expect(topic(text)).not.toBeNull();
});

test('обычное обращение темой не считается', () => {
  for (const text of ['При печати накладной выходит пустой лист', "Hisobot ochilmayapti", 'The report does not open', 'Не работает поиск по складу'])
    expect(topic(text), text).toBeNull();
});

test('список тем из настройки: администратор добавил слово', () => {
  expect(matchRestrictedTopic('Нужен акт сверки', { ...RESTRICTED_TOPICS_DEFAULT, payments: { ru: ['акт сверки'], uz: [], en: [] } })).toBe('payments');
});

test.each([
  ['позовите оператора'],
  ['Нужен человек, а не бот'],
  ['Соедините с живым человеком'],
  ['хочу поговорить с сотрудником'],
  ['operator please'],
  ['Inson bilan gaplashmoqchiman'],
  ['Одам керак'],
  ['Odam kerak'],
  ['Xodim bilan bog\'laning'],
  ['I need a human'],
  ['Can I talk to a real person'],
  ['п о з о в и т е  о п е р а т о р а'],
  ['oператор'],
])('просьба о человеке: %s', (text) => {
  expect(asksHuman(text)).toBe(true);
});

test('обычное обращение не просьба о человеке', () => {
  for (const text of ['Наш сотрудник не может войти', 'Отчёт по человеко-часам не строится', 'Xodimlar hisoboti ochilmayapti']) expect(asksHuman(text), text).toBe(false);
});

test('скелет: одна форма для обеих письменностей и апострофов', () => {
  expect(skeleton('Тўлов')).toBe(skeleton("To'lov"));
  expect(skeleton('Toʻlov')).toBe(skeleton("to'lov"));
  expect(skeleton('шартнома')).toBe(skeleton('shartnoma'));
});

// Независимая проверка M5b, находка I6: частые формы, которые списки пропускали. Повелительное и прошедшее время,
// "менеджер", "специалист", "не бот", греческие буквы-двойники.
test.each([
  ['payments', 'верните деньги за подписку'],
  ['payments', 'у нас списали оплату дважды'],
  ['security', 'кто-то зашёл в мою учётку без спроса'],
  ['contract', 'Вопрос по дοговοру'],
  ['complaint', 'Это жαлοбα на поддержку'],
])('находка I6, тема %s: %s', (expected, text) => {
  expect(topic(text)).toBe(expected);
});

test.each([
  ['позовите менеджера'],
  ['Нужно поговорить с менеджером'],
  ['Мне нужен специалист, а не бот'],
  ['Please let me talk to your manager'],
  ['Menejer bilan gaplashmoqchiman'],
  ['Менежер билан гаплашмоқчиман'],
  ['Mutaxassis kerak, bot emas'],
  ['Мутахассис керак, бот эмас'],
  ['Позовите οператора'],
])('находка I6, просьба о человеке: %s', (text) => {
  expect(asksHuman(text)).toBe(true);
});

test('находка I6: обычные вопросы про менеджеров и списание товара не передаются', () => {
  for (const text of ['Менеджер по продажам не видит заказы клиентов', 'Списали товар со склада, а остаток не изменился', 'Manager role cannot open the price list', 'Menejer buyurtmalarni ko\'rmayapti'])
    expect([asksHuman(text), topic(text)], text).toEqual([false, null]);
});

test('находка I6: греческие и прочие двойники сводятся к той же форме', () => {
  expect(skeleton('дοговοр')).toBe(skeleton('договор'));
  expect(skeleton('οperatοr')).toBe(skeleton('operator'));
});
