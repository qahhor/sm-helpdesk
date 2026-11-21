# syntax=docker/dockerfile:1
# Образ портала: сборка в несколько стадий, в итоговом образе только то, что нужно при работе.
# Образ один для web и для миграций: команды запуска разные (раздел 13.3 ТЗ).

# Базовый образ закреплён по digest: метка может начать указывать на другой образ (проверка main, S10).
# Новый digest при смене версии: docker buildx imagetools inspect node:<версия>-slim.
ARG NODE_IMAGE=node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

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
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Тексты политики обработки данных: читаются с диска при запросе (content/legal/README.md).
COPY content ./content
# Миграции и проверка контейнера запускаются из этого же образа.
COPY drizzle ./drizzle
COPY scripts/db ./scripts/db
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs
# Команда консоли: первый администратор, сброс доступа сотрудника, реестр серверов Smartup.
# Один файл со всеми зависимостями: node hub.mjs <команда>.
COPY --from=build /app/dist/hub.mjs ./hub.mjs

# Файлы приложения принадлежат root и только читаются процессом (проверка main, S10). Писать он может
# лишь в каталог кеша Next.js.
RUN mkdir -p .next/cache && chown 1001:1001 .next/cache

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]

# Процесс работает не от root.
USER 1001:1001
CMD ["node", "server.js"]
