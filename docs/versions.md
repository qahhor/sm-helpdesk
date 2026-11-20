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
| `class-variance-authority` | 0.7.1 | Apache-2.0 |
| `clsx` | 2.1.1 | MIT |
| `drizzle-orm` | 0.45.4 | Apache-2.0 |
| `get-nonce` | 1.0.1 | MIT |
| `lucide-react` | 1.72.0 | ISC |
| `next` | 16.4.6 | MIT |
| `next-intl` | 4.15.1 | MIT |
| `pg` | 8.23.1 | MIT |
| `radix-ui` | 1.8.1 | MIT |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `server-only` | 0.0.1 | MIT |
| `tailwind-merge` | 3.7.0 | MIT |
| `zod` | 4.6.7 | MIT |

## Зависимости разработки

| Пакет | Версия | Лицензия |
|---|---|---|
| `@axe-core/playwright` | 4.14.0 | MPL-2.0 |
| `@formatjs/icu-messageformat-parser` | 3.5.23 | MIT |
| `@playwright/test` | 1.63.0 | Apache-2.0 |
| `@tailwindcss/turbopack` | 4.3.5 | MIT |
| `@testcontainers/postgresql` | 12.2.1 | MIT |
| `@types/node` | 26.6.6 | MIT |
| `@types/pg` | 8.23.1 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `eslint` | 9.39.5 | MIT |
| `eslint-config-next` | 16.4.6 | MIT |
| `fontkit` | 3.0.0 | MIT |
| `subset-font` | 2.9.0 | BSD-3-Clause |
| `tailwindcss` | 4.3.5 | MIT |
| `testcontainers` | 12.2.1 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vitest` | 5.1.0 | MIT |
| `yaml` | 2.9.1 | ISC |

Лицензии всех пакетов, включая транзитивные: `pnpm licenses list`.
Почему выбраны именно эти версии: `docs/decisions/0001-stack-pins.md`.
