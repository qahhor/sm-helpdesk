# syntax=docker/dockerfile:1
# Образ портала: сборка в несколько стадий, в итоговом образе только то, что нужно при работе.
# Образ один для web и для миграций: команды запуска разные (раздел 13.3 ТЗ).

ARG NODE_IMAGE=node:26.13.1-slim

# --- Зависимости -------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- Сборка ------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm build

# --- Работа ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000

# Приложение: сервер и только те пакеты, которые он использует.
COPY --from=build --chown=1001:1001 /app/.next/standalone ./
COPY --from=build --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=build --chown=1001:1001 /app/public ./public
# Миграции и проверка контейнера запускаются из этого же образа.
COPY --chown=1001:1001 drizzle ./drizzle
COPY --chown=1001:1001 scripts/db ./scripts/db
COPY --chown=1001:1001 scripts/healthcheck.mjs ./scripts/healthcheck.mjs
# Команда консоли: первый администратор, сброс доступа сотрудника, реестр серверов Smartup.
# Один файл со всеми зависимостями: node hub.mjs <команда>.
COPY --from=build --chown=1001:1001 /app/dist/hub.mjs ./hub.mjs

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]

# Процесс работает не от root.
USER 1001:1001
CMD ["node", "server.js"]
