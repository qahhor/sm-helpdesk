import 'server-only';
import { text, timestamp } from 'drizzle-orm/pg-core';

// Служебные колонки (docs/naming.md, раздел 3). Значения записывает триггер app.stamp_row():
// сервис их не задаёт, а присланное значение база отбрасывает.
export const stampColumns = {
  createdBy: text('created_by'),
  createdOn: timestamp('created_on', { withTimezone: true }).notNull().defaultNow(),
  modifiedBy: text('modified_by'),
  modifiedOn: timestamp('modified_on', { withTimezone: true }).notNull().defaultNow(),
};
