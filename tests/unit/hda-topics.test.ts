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

// Проверка на AI-инъекции (волна 7, S-M4): обходы списков слов пустыми знаками-буквами, знаками разметки внутри
// слова, цифрами-двойниками и смешением латиницы и кириллицы в обе стороны.
const FILLERS: [string, string][] = [
  ['U+3164', 'ㅤ'],
  ['U+115F', 'ᅟ'],
  ['U+1160', 'ᅠ'],
  ['U+FFA0', 'ﾠ'],
  ['U+2800', '⠀'],
  ['U+034F', '͏'],
];
test.each(FILLERS)('обход пустым знаком %s внутри слова и вместо пробела', (_name, ch) => {
  expect(topic(`Вопрос про дого${ch}вор`)).not.toBeNull();
  expect(topic(`ref${ch}und please`)).not.toBeNull();
  expect(asksHuman(`позовите${ch}опе${ch}ратора`)).toBe(true);
  expect(asksHuman(`I need a hu${ch}man`)).toBe(true);
});

test.each([
  ['звёздочки', 'Вопрос по до*го*вору'],
  ['жирный Markdown', 'Это жа**ло**ба на поддержку'],
  ['подчёркивание', 'Наш юр_ист напишет'],
  ['обратные кавычки', 'Нас вз`лом`али'],
  ['тильды', 'Нужен воз~~врат~~ средств'],
  ['обратная косая черта', 'ref\\und please'],
  ['тег HTML', 'Вопрос по дог<b>ов</b>ору'],
  ['пустой комментарий HTML', 'We want a ref<!---->und'],
])('обход знаками разметки внутри слова: %s', (_name, text) => {
  expect(topic(text)).not.toBeNull();
});

test.each([
  ['ноль вместо "о" в кириллице', 'Вопрос по д0г0в0ру'],
  ['ноль вместо "о" в начале слова', 'Не прошла 0плата подписки'],
  ['тройка вместо "з"', 'Нас в3ломали'],
  ['ноль и единица в латинице', 'The b1ll1ng is wrong'],
  ['leet в латинице', 'Our account was h4ck3d'],
  ['пятёрка вместо s', 'This is a law5uit'],
])('обход цифрами-двойниками: %s', (_name, text) => {
  expect(topic(text)).not.toBeNull();
});

test.each([
  ['кириллическая "р" в латинском слове', 'рayment failed'],
  ['кириллические "а" и "с" в латинском слове', 'Our account was hасked'],
  ['кириллическая "с" в начале', 'We were сharged twice'],
  ['латиницы больше, чем кириллицы, в русском слове', 'Вопрос по дoroвopу'],
  ['латинские буквы в узбекском кириллическом слове', 'Шapтнoмa бўйича савол'],
])('обход смешением письменностей: %s', (_name, text) => {
  expect(topic(text)).not.toBeNull();
});

test('просьба о человеке с обходами: цифры, разметка, смешение', () => {
  for (const text of ['п0зовите 0ператора', 'нужен чел*ов*ек', 'I need a hum4n', 'talk to a real рerson', 'оп_ер_атор'] ) expect(asksHuman(text), text).toBe(true);
});

test('обходы не делают темой обычный текст с цифрами, разметкой и смешением', () => {
  for (const text of [
    'Накладная №4512 от 12.03.2026 не проведена, склад A4, код p1',
    'Отчёт **не открывается**, файл report_2026_final.xlsx, версия 5.12.3',
    'В карточке товара Coca-Cola 0,5л не сохраняется цена 15000',
    'Ombor 3 da qoldiq 0 chiqmoqda, hisobot_1 ochilmayapti',
    'Screen SMT-100 shows 0 rows after step 3',
  ]) {
    expect(topic(text), text).toBeNull();
    expect(asksHuman(text), text).toBe(false);
  }
});
