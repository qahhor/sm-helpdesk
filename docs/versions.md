# Версии

Файл собирает `node scripts/versions.mjs`. Руками не правится.

## Среда

| Что | Версия | Где задано |
|---|---|---|
| Node.js | 26.13.1 (LTS, ветка 26) | `.node-version`, `engines` в `package.json` |
| pnpm | 12.21.0 | `packageManager` в `package.json` |
| PostgreSQL | 18 с расширениями pgvector и pg_trgm, образ `pgvector/pgvector:pg18` | `compose.yaml` |

## Зависимости приложения

| Пакет | Версия | Лицензия |
|---|---|---|
| `next` | 16.4.6 | MIT |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |

## Зависимости разработки

| Пакет | Версия | Лицензия |
|---|---|---|
| `@tailwindcss/turbopack` | 4.3.5 | MIT |
| `@types/node` | 26.6.6 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `eslint` | 9.39.5 | MIT |
| `eslint-config-next` | 16.4.6 | MIT |
| `tailwindcss` | 4.3.5 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vitest` | 5.1.0 | MIT |

Лицензии всех пакетов, включая транзитивные: `pnpm licenses list`.
Почему выбраны именно эти версии: `docs/decisions/0001-stack-pins.md`.
