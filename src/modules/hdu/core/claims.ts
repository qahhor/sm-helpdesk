import * as z from 'zod';

// Сведения о пользователе из Smartup после сопоставления полей (src/modules/hdu/pref.ts, SMARTUP_CLAIMS).
// Портал берёт только перечисленные поля, лишние отбрасываются. Пустая строка считается отсутствием
// значения: так Smartup может передавать незаполненные поля. Идентификаторы могут прийти числом.

// Обязательные поля: идентификаторы человека и компании и их названия. Необязательное поле с неверным
// значением отбрасывается, а не лишает человека организации (проверка main, Q1).

const asText = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : value);

/** Идентификатор: не обрезается, длиннее предела не принимается. */
const id = (max: number) => z.preprocess(asText, z.string().trim().min(1).max(max));

/** Имя или название: длиннее предела обрезается. */
const title = (max: number) =>
  z.preprocess((value) => {
    const text = asText(value);
    return typeof text === 'string' ? Array.from(text.trim()).slice(0, max).join('') : text;
  }, z.string().min(1));

const optionalText = (max: number) =>
  z
    .preprocess((value) => {
      if (value === null || value === undefined) return undefined;
      const text = asText(value);
      return typeof text === 'string' && text.trim() === '' ? undefined : text;
    }, z.string().trim().min(1).max(max).optional())
    .catch(undefined);

/** Адрес из Smartup: неверный адрес не ломает вход, а просто не запоминается. */
const optionalEmail = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return z.email().max(254).safeParse(email).success ? email : undefined;
}, z.string().optional());

export const smartupProfile = z
  .object({
    id: id(200),
    name: title(200),
    companyId: id(200),
    companyName: title(300),
    inn: optionalText(50),
    role: optionalText(100),
    locale: optionalText(35),
    contactEmail: optionalEmail,
  })
  // Отсутствующее значение не остаётся ключом со значением undefined.
  .transform((profile) => Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)) as typeof profile);

/** Поля, не прошедшие проверку, по порядку схемы. Значения в журнал не попадают: в них личные данные. */
export function claimIssues(raw: unknown): string[] {
  const parsed = smartupProfile.safeParse(raw);
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))].filter(Boolean);
}

export type SmartupProfile = z.infer<typeof smartupProfile>;
