import * as z from 'zod';
import { HduError } from './error';
import { HUMAN_STAFF_ROLES } from './pref';

// Схемы входных данных модуля hdu. Каждая точка входа разбирает свой вход схемой (ТЗ 9.4, правило 7).

/** Адрес email: без пробелов по краям, в нижнем регистре, не длиннее 254 знаков. */
export const emailInput = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Пароль сотрудника: от 12 до 128 знаков (FR-ID-09). Пробелы не обрезаются: это часть пароля. */
export const passwordInput = z.string().min(12).max(128);

export const nameInput = z.string().trim().min(1).max(120);

/** Код из приложения с кодами: шесть цифр. */
export const totpCodeInput = z.string().trim().regex(/^\d{6}$/);

/** Одноразовый токен ссылки: 43 знака base64url (src/modules/hdu/tokens.ts). */
export const tokenInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const uuidInput = z.uuid();

/** Роль сотрудника-человека. Роль agent_bot приглашением не выдаётся. */
export const staffRoleInput = z.enum(HUMAN_STAFF_ROLES);

/** Разбирает вход схемой. Неверный вход превращается в ошибку модуля с кодом invalid_input. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HduError('invalid_input');
  return result.data;
}
