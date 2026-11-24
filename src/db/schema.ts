import 'server-only';

// Все таблицы предметной области в одном месте. Каждый модуль описывает свои таблицы
// в src/modules/<префикс>/schema.ts (docs/naming.md), здесь они только собираются.
// Тест tests/integration/schema-drift.test.ts сверяет этот список с базой.
export * from '@/modules/hdc/schema';
export * from '@/modules/hdk/schema';
export * from '@/modules/hdn/schema';
export * from '@/modules/hdr/schema';
export * from '@/modules/hdt/schema';
export * from '@/modules/hdu/schema';
export * from '@/modules/hdw/schema';
