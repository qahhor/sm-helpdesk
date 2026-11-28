> Черновик для юриста. Qoralama: ona tili egasi va yurist tekshirguncha portalda ko'rsatilmaydi. Rus tilidagi `docs/legal/privacy-draft.ru.md` matnining tarjimasi (plan M9, 11-vazifa). Tasdiqlangan matn `content/legal/privacy.uz.md` fayliga qo'yiladi.

# Smartup Hub shaxsiy ma'lumotlarni qayta ishlash siyosati

Smartup Hub (hub.smartup24.com) Smartup mijozlarini qo'llab-quvvatlash portali. Bu yerda portal qanday ma'lumotlarni saqlashi, kimga uzatishi, qancha muddat saqlashi va foydalanuvchining qanday huquqlari borligi yozilgan.

## Portal qanday ma'lumotlarni saqlaydi

- Ism va, agar Smartup uzatsa, elektron pochta manzili va telefon raqami.
- Smartup'dagi foydalanuvchi identifikatori, tashkilot va uning STIR raqami.
- Telegram identifikatori, agar foydalanuvchi portal botini o'zi bog'lagan bo'lsa.
- Interfeys tili.
- Murojaatlar matni va ularga ilovalar.
- Kirishlarning texnik jurnallari: vaqt, so'rov kelgan manzil, qurilma turi.

## Portal ma'lumotlarni nima uchun qayta ishlaydi

Foydalanuvchi portalga kirishi, qo'llab-quvvatlash xizmatiga murojaat yaratishi, javob va bildirishnomalar olishi, Smartup qo'llab-quvvatlash xizmati esa tez va aniq javob berishi uchun.

## Ma'lumotlar kimga uzatiladi

Portal ma'lumotlarni faqat usiz ishlay olmaydigan yetkazib beruvchilarga (subprotsessorlarga) uzatadi:

- Hetzner: portal va ma'lumotlar bazasini joylashtirish.
- Cloudflare: tarmoq, robotlardan himoya va fayllar ombori.
- Resend: xatlarni yuborish.
- Telegram: portal boti orqali bildirishnomalar va zaxira kirish havolalari. Botga murojaat raqami, 60 belgigacha mavzu va havola uzatiladi, murojaat matni uzatilmaydi.
- Anthropic: qo'llab-quvvatlashning birinchi liniyasi va javoblarni tahlil qilish uchun murojaatlar matni, yechim qoralamalari va tarjimalar uchun matnlar.
- Hermes Agent orqali Anthropic va OpenAI: mijozlar ko'rmaydigan ichki hisobotlar va tahlil uchun shaxsi oshkor qilinmagan murojaat matnlari (ismlar, manzillar, telefonlar va tashkilot nomlarisiz).

Bu yetkazib beruvchilarning serverlari O'zbekistondan tashqarida bo'lishi mumkin. Ro'yxat portalning har bir yangi bosqichi ishga tushishidan oldin shu siyosatda yangilanadi.

## AI-yordamchi

Murojaatga birinchi bo'lib AI-yordamchi javob berishi mumkin. Murojaat matnini tashqi AI xizmati (Anthropic) qayta ishlaydi. Tashkilotni AI orqali qayta ishlash faqat uning yozma roziligidan keyin yoqiladi; rozilik bo'lmasa, murojaatlar darhol qo'llab-quvvatlash xodimlariga tushadi. Tashkilot istalgan vaqtda AI orqali qayta ishlashdan voz kechishi mumkin: buning uchun Smartup menejeringizga murojaat qiling.

## Ma'lumotlar qancha saqlanadi

- Murojaatlar va yozishmalar: mijoz bilan shartnoma amal qilgan davrda va u tugaganidan keyin 3 yil.
- Ilovalar: murojaat yopilganidan keyin 1 yil.
- Texnik jurnallar: 30 kun.
- Huquqlar va sozlamalar bilan amallar audit jurnali: 3 yil.

## Foydalanuvchi huquqlari

- U haqida qanday ma'lumotlar saqlanayotganini bilish.
- Portal profilida ism, elektron pochta manzili va tilni tuzatish.
- Profilda Telegram'ni istalgan vaqtda uzish.
- Hisobni o'chirishni so'rash. Shunda ism va elektron pochta manzili shaxsi oshkor qilinmagan qiymatlar bilan almashtiriladi, murojaatlar matni esa tashkilotda qoladi: ular unga ish uchun kerak.

## Qanday bog'lanish mumkin

Ma'lumotlarni qayta ishlash bo'yicha savollarni Smartup menejeringizga yoki portal orqali qo'llab-quvvatlash xizmatiga yuboring.

> Yurist uchun savollar rus tilidagi qoralamada. ">" belgili qatorlar portalga o'tkazilmaydi.
