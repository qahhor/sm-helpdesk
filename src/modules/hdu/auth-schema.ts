import { sql } from 'drizzle-orm';
import { boolean, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Таблицы библиотеки входа (схема auth) для собственных запросов модуля hdu.
// Сами таблицы создаёт миграция drizzle/0003_auth_schema.sql, имена колонок задаёт библиотека.
// Библиотека работает с ними напрямую, через своё подключение: это описание ей не нужно.

const auth = pgSchema('auth');
const moment = (name: string) => timestamp(name, { withTimezone: true });

export const authUser = auth.table('user', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('emailVerified').notNull(),
  image: text('image'),
  createdAt: moment('createdAt').notNull().defaultNow(),
  updatedAt: moment('updatedAt').notNull().defaultNow(),
  twoFactorEnabled: boolean('twoFactorEnabled'),
  // Колонки портала.
  claimedEmail: text('claimedEmail'),
  onboardedAt: moment('onboardedAt'),
  lastOrgId: uuid('lastOrgId'),
  locale: text('locale').$type<'ru' | 'uz' | 'en'>(),
  policyVersion: text('policyVersion'),
  hintsSeenAt: moment('hintsSeenAt'),
});

export const authSession = auth.table('session', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  expiresAt: moment('expiresAt').notNull(),
  token: text('token').notNull(),
  createdAt: moment('createdAt').notNull().defaultNow(),
  updatedAt: moment('updatedAt').notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: uuid('userId').notNull(),
  // Колонки портала.
  activeOrgId: uuid('activeOrgId'),
  secondFactorAt: moment('secondFactorAt'),
  freshAuthAt: moment('freshAuthAt'),
});

export const authAccount = auth.table('account', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: uuid('userId').notNull(),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: moment('accessTokenExpiresAt'),
  refreshTokenExpiresAt: moment('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: moment('createdAt').notNull().defaultNow(),
  updatedAt: moment('updatedAt').notNull(),
});

export const authVerification = auth.table('verification', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: moment('expiresAt').notNull(),
  createdAt: moment('createdAt').notNull().defaultNow(),
  updatedAt: moment('updatedAt').notNull().defaultNow(),
});

export const authTwoFactor = auth.table('twoFactor', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  secret: text('secret').notNull(),
  backupCodes: text('backupCodes').notNull(),
  userId: uuid('userId').notNull(),
  verified: boolean('verified'),
  failedVerificationCount: integer('failedVerificationCount'),
  lockedUntil: moment('lockedUntil'),
});
