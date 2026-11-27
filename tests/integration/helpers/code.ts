import type { StaffActor } from '@/db/with-actor';
import { pools } from './db';

// Знания из кода напрямую в базу (веха M8c): подготовка данных суперпользователем без актора. Триггеры защиты
// пропускают подготовку без актора, служебные колонки заполняет база.

let serial = 0;

export type SeededStaff = { userId: string; actor: StaffActor };

/** Сотрудник с ролью: строка auth."user" и строка hdu_staff. */
export async function seedStaff(role: StaffActor['staffRole'], name = 'Сотрудник'): Promise<SeededStaff> {
  serial += 1;
  const user = await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ($1, $2, true) returning id`, [
    `${name} ${serial}`,
    `code-staff-${serial}-${Date.now()}-${Math.random()}@staff.test`,
  ]);
  const userId = user.rows[0].id as string;
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, $2)`, [userId, role]);
  return { userId, actor: { type: 'staff', userId, staffRole: role } };
}

export type SeededCatalog = { scanId: string; approvedId: string; draftId: string; approvedKey: string; draftKey: string; approvedSignature: string; moduleNoteId: string };

/** Сканирование, утверждённая и черновая записи с шаблонами, заметка о модуле. Ключи уникальны на каждый вызов. */
export async function seedCodeCatalog(tokenId: string, input: { approvedBy: string; code?: string | null } = { approvedBy: '' }): Promise<SeededCatalog> {
  serial += 1;
  const suffix = `${serial}_${Date.now() % 100000}`;
  const scanId = (
    await pools.root.query(
      `insert into hda_code_scans (token_id, scan_key, repository, commit_ref, added_count, error_count, module_count) values ($1, $2, 'smartup-core', 'abc1234', 2, 2, 1) returning scan_id`,
      [tokenId, `2026-W47-${suffix}`],
    )
  ).rows[0].scan_id as string;
  const entry = async (key: string, status: string, template: string, approvedBy: string | null) => {
    const id = (
      await pools.root.query(
        `insert into hda_code_error_entries (scan_id, approved_by, key, code, repository, module_code, raised_in, conditions, user_cause, what_to_check, kind, confidence, status, change_kind, scan_digest, approved_on)
         values ($1, $2, $3, $4, 'smartup-core', 'orders', '[{"object": "ORDER_PKG.SAVE_ORDER", "path": "db/packages/order_pkg.pkb", "line": 412}]',
                 'Количество больше остатка при контроле остатков', 'На складе меньше товара, чем в заказе', '["Остаток по товару на складе заказа", "Включён ли контроль остатков"]',
                 'user_error', 0.8, $5, 'new', repeat('a', 64), case when $2::uuid is not null then now() end) returning entry_id`,
        [scanId, approvedBy, key, input.code === undefined ? 'ORA-20001' : input.code, status],
      )
    ).rows[0].entry_id as string;
    await pools.root.query(`insert into hda_code_error_templates (entry_id, locale, template) values ($1, 'ru', $2)`, [id, template]);
    return id;
  };
  const approvedKey = `orders.insufficient_stock_${suffix}`;
  const draftKey = `stock.negative_balance_${suffix}`;
  const approvedId = await entry(approvedKey, 'approved', `Недостаточно остатка товара {product} на складе {warehouse} ${suffix}`, input.approvedBy || null);
  const draftId = await entry(draftKey, 'draft', `Отрицательный остаток товара {product} ${suffix}`, null);
  const approvedSignature = (await pools.root.query(`select signature from hda_code_error_entries where entry_id = $1`, [approvedId])).rows[0].signature as string;
  const moduleNoteId = (
    await pools.root.query(
      `insert into hda_code_module_notes (scan_id, module_code, repository, name, summary, depends_on, screens, change_kind, scan_digest)
       values ($1, $2, 'smartup-core', '{"ru": "Заказы"}', 'Создание и проведение заказов', '{stock}', '[{"code": "order_edit", "name": {"ru": "Новый заказ"}}]', 'new', repeat('b', 64)) returning note_id`,
      [scanId, `orders_${suffix}`],
    )
  ).rows[0].note_id as string;
  return { scanId, approvedId, draftId, approvedKey, draftKey, approvedSignature, moduleNoteId };
}
