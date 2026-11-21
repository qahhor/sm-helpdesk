import * as z from 'zod';

// Модуль hdr: схема файла выгрузки модулей Smartup для команды hub modules:import (план M2, задача 10).

const text = z.string().trim().min(1, { error: 'пустое значение' }).max(200, { error: 'длиннее 200 знаков' });

/** Название по языкам: русское обязательно, оно запасное для остальных (ограничение hdr_product_modules_c1). */
const localized = z.strictObject({ ru: text, uz: text.optional(), en: text.optional() }, { error: 'ожидается объект с названием ru' });

const code = z
  .string({ error: 'ожидается строка' })
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/, { error: 'код: латинские буквы, цифры, _ . : -, до 100 знаков' });

export const moduleRecord = z.strictObject({
  code,
  parentCode: code.nullable().optional(),
  name: localized,
  screens: z.array(z.strictObject({ code, name: localized }), { error: 'ожидается массив экранов' }).max(500).default([]),
});

export const modulesFile = z.array(moduleRecord, { error: 'ожидается массив модулей' }).min(1, { error: 'нет ни одного модуля' }).max(5000);

export type ModuleRecord = z.infer<typeof moduleRecord>;
