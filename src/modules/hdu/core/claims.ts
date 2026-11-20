import * as z from 'zod';

// Сведения о пользователе из Smartup после сопоставления полей (src/modules/hdu/pref.ts, SMARTUP_CLAIMS).
// Портал берёт только перечисленные поля, лишние отбрасываются. Пустая строка считается отсутствием
// значения: так Smartup может передавать незаполненные поля. Идентификаторы могут прийти числом.

const text = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : value),
    z.string().trim().min(1).max(max),
  );

const optionalText = (max: number) =>
  z.preprocess((value) => {
    if (value === null || value === undefined) return undefined;
    const asText = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    return typeof asText === 'string' && asText.trim() === '' ? undefined : asText;
  }, z.string().trim().min(1).max(max).optional());

/** Адрес из Smartup: неверный адрес не ломает вход, а просто не запоминается. */
const optionalEmail = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return z.email().max(254).safeParse(email).success ? email : undefined;
}, z.string().optional());

export const smartupProfile = z
  .object({
    id: text(200),
    name: text(200),
    companyId: text(200),
    companyName: text(300),
    inn: optionalText(50),
    role: optionalText(100),
    locale: optionalText(35),
    contactEmail: optionalEmail,
  })
  // Отсутствующее значение не остаётся ключом со значением undefined.
  .transform((profile) => Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)) as typeof profile);

export type SmartupProfile = z.infer<typeof smartupProfile>;
