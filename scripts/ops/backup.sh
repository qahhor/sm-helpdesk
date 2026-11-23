#!/usr/bin/env bash
# Ночная копия базы портала (ТЗ 13.7; аудит 23.11.2026, находка S5; план W0, задача 7).
#
# Копия шифруется до записи на диск: pg_dump отдаёт поток, age шифрует его открытым ключом получателя.
# Закрытого ключа на сервере нет: взлом сервера или утечка ключа хранилища копий не раскрывают данные.
# Восстановление: docs/runbooks/restore.md.
#
# Переменные (файл /opt/smartup-hub/backup.env, права 600):
#   BACKUP_RECIPIENT  открытый ключ age получателя (age1...). Обязателен.
#   BACKUP_REMOTE     куда выгружать, в записи rclone (например r2-backups:hub-backups). Обязателен.
#   HUB_DIR           каталог с compose.prod.yaml (по умолчанию /opt/smartup-hub)
#   BACKUP_DIR        каталог копий на сервере (по умолчанию /var/backups/smartup-hub)
#   BACKUP_KEEP_DAYS  сколько суток хранить копии на сервере (по умолчанию 14)
#   HUB_DB_NAME       имя базы (по умолчанию hub)
set -euo pipefail

: "${BACKUP_RECIPIENT:?задайте BACKUP_RECIPIENT: открытый ключ age получателя копий}"
: "${BACKUP_REMOTE:?задайте BACKUP_REMOTE: место выгрузки в записи rclone}"
HUB_DIR="${HUB_DIR:-/opt/smartup-hub}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/smartup-hub}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
HUB_DB_NAME="${HUB_DB_NAME:-hub}"
# Копия меньше этого размера считается пустой: pg_dump не отдал данные.
MIN_BYTES=1024

umask 077
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/hub-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
part="$file.part"
trap 'rm -f "$part"' EXIT

# pipefail: сбой pg_dump или шифрования останавливает сценарий, недописанный файл удаляет trap.
docker compose -f "$HUB_DIR/compose.prod.yaml" exec -T postgres pg_dump -U postgres -Fc "$HUB_DB_NAME" | age -r "$BACKUP_RECIPIENT" -o "$part"

size=$(wc -c < "$part")
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "Копия базы пуста ($size байт): выгрузка отменена" >&2
  exit 1
fi
mv "$part" "$file"

rclone copy "$file" "$BACKUP_REMOTE"
find "$BACKUP_DIR" -name 'hub-*.dump.age' -mtime +"$BACKUP_KEEP_DAYS" -delete
# Отметка последней удачной копии: по её возрасту внешняя проверка даёт сигнал дежурным.
date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/last-success"
echo "Копия базы выгружена: $(basename "$file"), $size байт"
