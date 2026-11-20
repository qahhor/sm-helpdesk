// Запуск команд Next.js с выключенной телеметрией.
// Внешние сервисы подключаются только по решению владельца продукта (CLAUDE.md),
// а переменная должна быть задана до старта любого процесса Next.js.
// Использование: node scripts/next.mjs dev | build | typegen
import { rmSync } from 'node:fs';

process.env.NEXT_TELEMETRY_DISABLED = '1';

// Типы маршрутов, оставшиеся от `next dev`, устаревают при удалении страниц и ломают проверку типов.
if (process.argv[2] === 'typegen') rmSync('.next/dev/types', { recursive: true, force: true });

await import('next/dist/bin/next');
