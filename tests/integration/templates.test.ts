import { expect, test } from 'vitest';
import { listAllTemplates, listTemplates, renderTemplate, saveTemplate } from '@/modules/hdr/api';
import { staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Шаблоны ответов (FR-AG-06, 10.5; план M3, задача 10): по языкам портала, короткий код, ведёт администратор.

const GREET = { shortcut: 'greet', title: 'Приветствие', body: { ru: 'Здравствуйте! Спасибо за обращение.', uz: 'Assalomu alaykum! Murojaat uchun rahmat.' }, moduleId: null, isEnabled: true };

test('шаблон на языке обращения, без перевода русский с пометкой', async () => {
  const f = await seedTwoOrgs();
  await saveTemplate(staffCtx(f.adminStaff), GREET);
  const [template] = await listTemplates(staffCtx(f.l1), {});
  expect(template).toMatchObject({ shortcut: 'greet', title: 'Приветствие' });
  if (!template) throw new Error('шаблона нет');
  expect(renderTemplate(template, 'uz')).toEqual({ text: 'Assalomu alaykum! Murojaat uchun rahmat.', fallback: false });
  expect(renderTemplate(template, 'ru')).toEqual({ text: 'Здравствуйте! Спасибо за обращение.', fallback: false });
  expect(renderTemplate(template, 'en')).toEqual({ text: 'Здравствуйте! Спасибо за обращение.', fallback: true });
});

test('код уникален, недопустимые знаки отклоняются', async () => {
  const f = await seedTwoOrgs();
  const admin = staffCtx(f.adminStaff);
  await saveTemplate(admin, GREET);
  await expect(saveTemplate(admin, { ...GREET, title: 'Другое' })).rejects.toMatchObject({ code: 'shortcut_taken' });
  // Код приводится к строчным: "GREET" тот же код.
  await expect(saveTemplate(admin, { ...GREET, shortcut: 'GREET' })).rejects.toMatchObject({ code: 'shortcut_taken' });
  for (const shortcut of ['привет', 'a b', '-greet', '', 'x'.repeat(41), 'greet!'])
    await expect(saveTemplate(admin, { ...GREET, shortcut }), shortcut).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveTemplate(admin, { ...GREET, shortcut: 'no-ru', body: { uz: 'Faqat o‘zbekcha' } })).rejects.toMatchObject({ code: 'invalid_input' });
  // Правка существующего шаблона с тем же кодом и выключение.
  const [saved] = await listAllTemplates(admin);
  await saveTemplate(admin, { ...GREET, templateId: saved?.templateId, title: 'Приветствие клиента', isEnabled: false });
  expect((await listAllTemplates(admin)).map((t) => [t.shortcut, t.title, t.isEnabled])).toEqual([['greet', 'Приветствие клиента', false]]);
  expect(await listTemplates(staffCtx(f.l1), {})).toEqual([]);
});

test('вести шаблоны может только администратор, клиент не видит ни одного', async () => {
  const f = await seedTwoOrgs();
  await expect(saveTemplate(staffCtx(f.l1), GREET)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveTemplate(staffCtx(f.care), GREET)).rejects.toMatchObject({ code: 'forbidden' });
  await saveTemplate(staffCtx(f.adminStaff), GREET);
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('stock', '{"ru": "Склад"}') returning module_id`)).rows[0].module_id as string;
  await saveTemplate(staffCtx(f.adminStaff), { ...GREET, shortcut: 'stock-check', title: 'Проверка остатков', moduleId });
  // Для обращения модуля: шаблоны модуля и общие; без модуля только общие.
  expect((await listTemplates(staffCtx(f.care), { moduleId })).map((t) => t.shortcut)).toEqual(['greet', 'stock-check']);
  expect((await listTemplates(staffCtx(f.care), {})).map((t) => t.shortcut)).toEqual(['greet']);
  expect((await listTemplates(staffCtx(f.care), { q: 'остат', moduleId })).map((t) => t.shortcut)).toEqual(['stock-check']);
  expect(await asActor(pools.app, f.aUser.actor, (c) => c.query(`select count(*)::int as n from hdr_reply_templates`).then((r) => r.rows[0].n))).toBe(0);
  const audit = await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'template.saved'`);
  expect(audit.rows[0].n).toBe(2);
});
