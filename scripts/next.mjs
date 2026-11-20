// Запуск команд Next.js с выключенной телеметрией.
// Внешние сервисы подключаются только по решению владельца продукта (CLAUDE.md),
// а переменная должна быть задана до старта любого процесса Next.js.
// Использование: node scripts/next.mjs dev | build | typegen
process.env.NEXT_TELEMETRY_DISABLED = '1';
await import('next/dist/bin/next');
