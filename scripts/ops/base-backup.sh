#!/usr/bin/env bash
# Базовая копия базы для восстановления на момент времени (ТЗ 13.7; аудит 23.11.2026, находка O5; решение 0039).
#
# Копия каталога данных снимается на работающей базе (pg_basebackup) и шифруется потоком до записи на диск.
# Восстановление: базовая копия плюс сегменты журнала после неё (wal-ship.sh). Запускать раз в неделю; ночная
# логическая копия (backup.sh) остаётся: она восстанавливается проще и переносится между версиями PostgreSQL.
#
# Переменные (файл /opt/smartup-hub/backup.env, права 600):
#   BACKUP_RECIPIENT  открытый ключ age получателя (age1...). Обязателен.
#   BACKUP_REMOTE     место выгрузки в записи rclone. Обязателен. Копии кладутся в подкаталог base.
#   HUB_DIR           каталог с compose.prod.yaml (по умолчанию /opt/smartup-hub)
#   BACKUP_DIR        каталог копий на сервере (по умолчанию /var/backups/smartup-hub)
#   BASE_KEEP_DAYS    сколько суток хранить базовые копии на сервере (по умолчанию 15: две недельные копии)
set -euo pipefail

: "${BACKUP_RECIPIENT:?задайте BACKUP_RECIPIENT: открытый ключ age получателя копий}"
: "${BACKUP_REMOTE:?задайте BACKUP_REMOTE: место выгрузки в записи rclone}"
HUB_DIR="${HUB_DIR:-/opt/smartup-hub}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/smartup-hub}"
BASE_KEEP_DAYS="${BASE_KEEP_DAYS:-15}"
# Копия меньше этого размера считается пустой: pg_basebackup не отдал данные.
MIN_BYTES=1024

umask 077
mkdir -p "$BACKUP_DIR/base"
file="$BACKUP_DIR/base/base-$(date -u +%Y%m%dT%H%M%SZ).tar.age"
part="$file.part"
trap 'rm -f "$part"' EXIT

# Поток tar без журнала: журнал лежит в архиве сегментов. -c fast: не ждать плановой контрольной точки.
# pipefail: сбой pg_basebackup или шифрования останавливает сценарий, недописанный файл удаляет trap.
docker compose -f "$HUB_DIR/compose.prod.yaml" exec -T postgres pg_basebackup -U postgres -D - -Ft -X none -c fast | age -r "$BACKUP_RECIPIENT" -o "$part"

size=$(wc -c < "$part")
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "Базовая копия пуста ($size байт): выгрузка отменена" >&2
  exit 1
fi
mv "$part" "$file"

rclone copy "$file" "$BACKUP_REMOTE/base"
find "$BACKUP_DIR/base" -name 'base-*.tar.age' -mtime +"$BASE_KEEP_DAYS" -delete
date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/base/last-success"
echo "Базовая копия выгружена: $(basename "$file"), $size байт"
