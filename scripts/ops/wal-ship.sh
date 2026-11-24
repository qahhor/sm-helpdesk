#!/usr/bin/env bash
# Выгрузка сегментов журнала базы (непрерывный архив; ТЗ 13.7; аудит 23.11.2026, находка O5; решение 0039).
#
# PostgreSQL складывает готовые сегменты журнала в каталог на сервере (archive_command в compose.prod.yaml).
# Этот сценарий раз в минуту шифрует каждый сегмент открытым ключом получателя и выгружает его. С сервера сегмент
# удаляется только после удачной выгрузки. Сегменты идут по порядку имён: при сбое следующие ждут.
# Вместе с базовой копией (base-backup.sh) архив даёт восстановление на момент времени: docs/runbooks/restore.md.
#
# Переменные (файл /opt/smartup-hub/backup.env, права 600):
#   BACKUP_RECIPIENT  открытый ключ age получателя (age1...). Обязателен.
#   BACKUP_REMOTE     место выгрузки в записи rclone (например r2-backups:hub-backups). Обязателен.
#                     Сегменты кладутся в подкаталог wal.
#   WAL_DIR           каталог сегментов на сервере (по умолчанию /opt/smartup-hub/wal-archive)
set -euo pipefail

: "${BACKUP_RECIPIENT:?задайте BACKUP_RECIPIENT: открытый ключ age получателя копий}"
: "${BACKUP_REMOTE:?задайте BACKUP_REMOTE: место выгрузки в записи rclone}"
WAL_DIR="${WAL_DIR:-/opt/smartup-hub/wal-archive}"

umask 077
[ -d "$WAL_DIR" ] || { echo "Каталог сегментов журнала не найден: $WAL_DIR" >&2; exit 1; }

# Один запуск за раз: следующий запуск по расписанию не должен выгружать тот же сегмент.
exec 9> "$WAL_DIR/.ship.lock"
flock -n 9 || exit 0

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

shipped=0
# Имя сегмента: 24 шестнадцатеричных знака, у служебных файлов журнала есть продолжение (.backup, .history, .partial).
# Файл с окончанием .tmp ещё пишется базой и не берётся.
while IFS= read -r name; do
  [ -n "$name" ] || continue
  age -r "$BACKUP_RECIPIENT" -o "$work/$name.age" "$WAL_DIR/$name"
  rclone copy "$work/$name.age" "$BACKUP_REMOTE/wal"
  rm -f "$WAL_DIR/$name" "$work/$name.age"
  shipped=$((shipped + 1))
done < <(find "$WAL_DIR" -maxdepth 1 -type f -printf '%f\n' | grep -E '^[0-9A-F]{8}(\.history|[0-9A-F]{16}(\.partial|\.[0-9A-F]{8}\.backup)?)$' | sort)

# Отметка последней удачной выгрузки: по её возрасту внешняя проверка даёт сигнал дежурным.
date -u +%Y-%m-%dT%H:%M:%SZ > "$WAL_DIR/last-shipped"
[ "$shipped" -eq 0 ] || echo "Сегменты журнала выгружены: $shipped"
