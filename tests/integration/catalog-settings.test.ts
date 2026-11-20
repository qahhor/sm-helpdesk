import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { appSettings } from '@/modules/hdc/schema';
import { productModules } from '@/modules/hdr/schema';
import { admin, agentL1, clientA, system } from './helpers/db';

test('справочник модулей читают все акторы, меняет только admin', async () => {
  await withActor(admin, (tx) => tx.insert(productModules).values({ code: 'stock', name: { ru: 'Склад' } }));
  for (const actor of [clientA, agentL1, system]) {
    expect(await withActor(actor, (tx) => tx.select().from(productModules))).not.toHaveLength(0);
    await expect(
      withActor(actor, (tx) => tx.insert(productModules).values({ code: `x-${actor.type}`, name: { ru: 'x' } })),
    ).rejects.toThrow(/row-level security/);
    // Изменение и удаление чужими акторами не затрагивают ни одной строки.
    await withActor(actor, (tx) => tx.update(productModules).set({ state: 'passive' }));
    await withActor(actor, (tx) => tx.delete(productModules));
  }
  const rows = await withActor(admin, (tx) => tx.select().from(productModules));
  expect(rows.map((r) => [r.code, r.state])).toEqual([['stock', 'active']]);
});

test('настройки портала читают система и admin, клиент и первая линия не видят', async () => {
  await withActor(admin, (tx) => tx.insert(appSettings).values({ code: 'ai.enabled', value: true }));
  expect(await withActor(system, (tx) => tx.select().from(appSettings))).toHaveLength(1);
  expect(await withActor(admin, (tx) => tx.select().from(appSettings))).toHaveLength(1);
  expect(await withActor(clientA, (tx) => tx.select().from(appSettings))).toEqual([]);
  expect(await withActor(agentL1, (tx) => tx.select().from(appSettings))).toEqual([]);
  await expect(
    withActor(system, (tx) => tx.insert(appSettings).values({ code: 'x', value: 1 })),
  ).rejects.toThrow(/row-level security/);
});

test('название модуля без русского варианта отклоняется', async () => {
  await expect(
    withActor(admin, (tx) => tx.insert(productModules).values({ code: 'bad', name: { en: 'Bad' } as never })),
  ).rejects.toThrow(/check constraint|hdr_product_modules_c1/);
});

test('код модуля и код настройки уникальны', async () => {
  await withActor(admin, (tx) => tx.insert(productModules).values({ code: 'dup', name: { ru: 'Один' } }));
  await expect(
    withActor(admin, (tx) => tx.insert(productModules).values({ code: 'dup', name: { ru: 'Два' } })),
  ).rejects.toThrow(/hdr_product_modules_u1|duplicate key/);
  await withActor(admin, (tx) => tx.insert(appSettings).values({ code: 'k', value: 1 }));
  await expect(
    withActor(admin, (tx) => tx.insert(appSettings).values({ code: 'k', value: 2 })),
  ).rejects.toThrow(/hdc_settings_u1|duplicate key/);
});

test('служебные колонки заполняет база, подделать автора нельзя', async () => {
  const [row] = await withActor(admin, (tx) =>
    tx
      .insert(appSettings)
      .values({ code: 'sla.l2_take_minutes', value: 30, createdBy: 'someone-else', modifiedBy: 'someone-else' })
      .returning(),
  );
  expect(row.createdBy).toBe(admin.userId);
  expect(row.modifiedBy).toBe(admin.userId);
  expect(row.createdOn).toBeInstanceOf(Date);

  const otherAdmin = { ...admin, userId: 'staff-admin-2' };
  const [changed] = await withActor(otherAdmin, (tx) =>
    tx
      .update(appSettings)
      .set({ value: 45, createdBy: 'forged', createdOn: new Date(0) })
      .where(eq(appSettings.code, 'sla.l2_take_minutes'))
      .returning(),
  );
  expect(changed.createdBy).toBe(admin.userId);
  expect(changed.createdOn).toEqual(row.createdOn);
  expect(changed.modifiedBy).toBe('staff-admin-2');
  expect(changed.modifiedOn.getTime()).toBeGreaterThanOrEqual(row.modifiedOn.getTime());
});

test('подчинённый модуль ссылается на существующий родительский', async () => {
  const [parent] = await withActor(admin, (tx) =>
    tx.insert(productModules).values({ code: 'sales', name: { ru: 'Продажи' } }).returning(),
  );
  await withActor(admin, (tx) =>
    tx.insert(productModules).values({ code: 'sales.orders', parentId: parent.moduleId, name: { ru: 'Заказы' } }),
  );
  await expect(
    withActor(admin, (tx) =>
      tx.insert(productModules).values({
        code: 'orphan',
        parentId: '019a0000-0000-7000-8000-000000000000',
        name: { ru: 'Без родителя' },
      }),
    ),
  ).rejects.toThrow(/hdr_product_modules_f1|foreign key/);
});
