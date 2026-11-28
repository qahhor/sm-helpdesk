# Версии

Файл собирает `node scripts/versions.mjs`. Руками не правится.

## Среда

| Что | Версия | Где задано |
|---|---|---|
| Node.js | 26.13.1 (LTS, ветка 26) | `.node-version`, `engines` в `package.json` |
| pnpm | 12.21.0 | `packageManager` в `package.json` |
| PostgreSQL | 18 с расширениями pgvector и pg_trgm, образ `pgvector/pgvector:pg18` | `compose.yaml` |
| Typesense | 30.2, образ `typesense/typesense:30.2` по digest (план W6) | `compose.prod.yaml`, `tests/integration/setup/global-setup.ts` |

## Зависимости приложения

| Пакет | Версия | Лицензия |
|---|---|---|
| `@better-auth/sso` | 1.7.26 | MIT |
| `@formatjs/icu-messageformat-parser` | 3.5.23 | MIT |
| `@tiptap/core` | 3.34.0 | MIT |
| `@tiptap/extension-bold` | 3.34.0 | MIT |
| `@tiptap/extension-code` | 3.34.0 | MIT |
| `@tiptap/extension-document` | 3.34.0 | MIT |
| `@tiptap/extension-hard-break` | 3.34.0 | MIT |
| `@tiptap/extension-heading` | 3.34.0 | MIT |
| `@tiptap/extension-image` | 3.34.0 | MIT |
| `@tiptap/extension-italic` | 3.34.0 | MIT |
| `@tiptap/extension-link` | 3.34.0 | MIT |
| `@tiptap/extension-list` | 3.34.0 | MIT |
| `@tiptap/extension-paragraph` | 3.34.0 | MIT |
| `@tiptap/extension-table` | 3.34.0 | MIT |
| `@tiptap/extension-text` | 3.34.0 | MIT |
| `@tiptap/extensions` | 3.34.0 | MIT |
| `@tiptap/pm` | 3.34.0 | MIT |
| `@tiptap/react` | 3.34.0 | MIT |
| `aws4fetch` | 1.0.20 | MIT |
| `better-auth` | 1.7.26 | MIT |
| `class-variance-authority` | 0.7.1 | Apache-2.0 |
| `clsx` | 2.1.1 | MIT |
| `drizzle-orm` | 0.45.4 | Apache-2.0 |
| `get-nonce` | 1.0.1 | MIT |
| `jose` | 6.2.17 | MIT |
| `kysely` | 0.29.9 | MIT |
| `lucide-react` | 1.75.0 | ISC |
| `next` | 16.4.6 | MIT |
| `next-intl` | 4.15.1 | MIT |
| `parse5` | 8.1.1 | MIT |
| `pg` | 8.23.1 | MIT |
| `pg-boss` | 12.38.2 | MIT |
| `radix-ui` | 1.8.1 | MIT |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `server-only` | 0.0.1 | MIT |
| `tailwind-merge` | 3.7.0 | MIT |
| `undici` | 8.12.4 | MIT |
| `uqr` | 0.1.3 | MIT |
| `zod` | 4.6.7 | MIT |

## Зависимости разработки

| Пакет | Версия | Лицензия |
|---|---|---|
| `@axe-core/playwright` | 4.14.0 | MPL-2.0 |
| `@lhci/cli` | 0.16.1 | Apache-2.0 |
| `@playwright/test` | 1.65.1 | Apache-2.0 |
| `@tailwindcss/turbopack` | 4.3.5 | MIT |
| `@testcontainers/postgresql` | 12.2.1 | MIT |
| `@types/node` | 26.6.6 | MIT |
| `@types/pg` | 8.23.1 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `eslint` | 9.39.5 | MIT |
| `eslint-config-next` | 16.4.6 | MIT |
| `fontkit` | 3.0.0 | MIT |
| `oauth2-mock-server` | 9.3.0 | MIT |
| `rolldown` | 1.3.3 | MIT |
| `subset-font` | 2.9.0 | BSD-3-Clause |
| `tailwindcss` | 4.3.5 | MIT |
| `testcontainers` | 12.2.1 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vitest` | 5.1.1 | MIT |
| `yaml` | 2.9.1 | ISC |

Лицензии всех пакетов, включая транзитивные: `pnpm licenses list`.
Почему выбраны именно эти версии: `docs/decisions/0001-stack-pins.md`.
