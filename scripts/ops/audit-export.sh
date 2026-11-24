#!/usr/bin/env bash
# Выгрузка журнала аудита за пределы сервера (вопрос 17, решение владельца 24.11.2026; решение 0041).
#
# Журнал аудита лежит в базе портала: кто получил доступ к серверу, может его стереть. Раз в сутки новые записи
# журнала выгружаются в бакет резервных копий, в подкаталог audit. Файл шифруется открытым ключом получателя до
# записи на диск, закрытого ключа на сервере нет. Каждый запуск берёт записи с отметки прошлой удачной выгрузки:
# пропущенные сутки попадут в следующий файл. Отметка сдвигается только после выгрузки. Записи последних 15 минут
# уходят со следующим запуском.
#
# Переменные (файл /opt/smartup-hub/backup.env, права 600):
#   BACKUP_RECIPIENT  открытый ключ age получателя (age1...). Обязателен.
#   BACKUP_REMOTE     место выгрузки в записи rclone. Обязателен. Файлы кладутся в подкаталог audit.
#   HUB_DIR           каталог с compose.prod.yaml (по умолчанию /opt/smartup-hub)
#   BACKUP_DIR        каталог копий на сервере (по умолчанию /var/backups/smartup-hub)
#   BACKUP_KEEP_DAYS  сколько суток хранить файлы на сервере (по умолчанию 14)
#   HUB_DB_NAME       имя базы (по умолчанию hub)
set -euo pipefail

: "${BACKUP_RECIPIENT:?задайте BACKUP_RECIPIENT: открытый ключ age получателя копий}"
: "${BACKUP_REMOTE:?задайте BACKUP_REMOTE: место выгрузки в записи rclone}"
HUB_DIR="${HUB_DIR:-/opt/smartup-hub}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/smartup-hub}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
HUB_DB_NAME="${HUB_DB_NAME:-hub}"

umask 077
dir="$BACKUP_DIR/audit"
mkdir -p "$dir"
state="$dir/last-exported"

from='1970-01-01T00:00:00Z'
[ -f "$state" ] && from=$(head -n 1 "$state")
# Отметка попадает в текст запроса: принимается только время в одном виде.
if ! [[ "$from" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "Отметка прошлой выгрузки испорчена: $state" >&2
  exit 1
fi
# Верхняя граница отстаёт на 15 минут. Время записи журнала это начало её транзакции: запись из транзакции,
# которая началась до границы и зафиксировалась после неё, иначе не попала бы ни в этот файл, ни в следующий.
to=$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)

file="$dir/audit-$(date -u +%Y%m%dT%H%M%SZ).csv.age"
part="$file.part"
trap 'rm -f "$part"' EXIT

query="copy (select * from hdc_audit_log where created_on >= '$from' and created_on < '$to' order by created_on, audit_id) to stdout with (format csv, header)"
# pipefail: сбой чтения базы или шифрования останавливает сценарий, недописанный файл удаляет trap.
docker compose -f "$HUB_DIR/compose.prod.yaml" exec -T postgres psql -U postgres -d "$HUB_DB_NAME" -v ON_ERROR_STOP=1 -Atc "$query" | age -r "$BACKUP_RECIPIENT" -o "$part"
mv "$part" "$file"

rclone copy "$file" "$BACKUP_REMOTE/audit"
echo "$to" > "$state"
find "$dir" -name 'audit-*.csv.age' -mtime +"$BACKUP_KEEP_DAYS" -delete
echo "Журнал аудита выгружен: $(basename "$file"), записи с $from по $to"
