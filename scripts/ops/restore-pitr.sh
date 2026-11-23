#!/usr/bin/env bash
# Восстановление базы на момент времени (ТЗ 13.7; аудит 23.11.2026, находка O5; решение 0039).
# Порядок действий вокруг сценария (остановка портала, новый том, проверка): docs/runbooks/restore.md.
#
# Вызов:
#   restore-pitr.sh <базовая копия .tar.age> <каталог сегментов .age> <момент времени> <пустой каталог данных>
#
# Сценарий расшифровывает базовую копию в каталог данных, расшифровывает сегменты журнала в подкаталог
# wal-restore и записывает настройки восстановления. Базу после этого запускают на этом каталоге: она
# проигрывает журнал до заданного момента и открывается на запись.
#
# Момент времени: 'ГГГГ-ММ-ДД ЧЧ:ММ:СС+05' (с часовым поясом).
# Переменные:
#   BACKUP_IDENTITY  файл закрытого ключа age. Обязателен. Ключ хранится вне сервера и приносится на время работ.
#   WAL_RESTORE_PATH путь к сегментам, каким его увидит база (по умолчанию <каталог данных>/wal-restore)
set -euo pipefail

usage='Вызов: restore-pitr.sh <базовая копия .tar.age> <каталог сегментов .age> <момент времени ГГГГ-ММ-ДД ЧЧ:ММ:СС+05> <пустой каталог данных>'
[ $# -eq 4 ] || { echo "$usage" >&2; exit 2; }
base="$1"
wal_dir="$2"
target="$3"
data="$4"

: "${BACKUP_IDENTITY:?задайте BACKUP_IDENTITY: файл закрытого ключа age}"
[ -f "$BACKUP_IDENTITY" ] || { echo "Файл закрытого ключа не найден: $BACKUP_IDENTITY" >&2; exit 1; }
[ -f "$base" ] || { echo "Базовая копия не найдена: $base" >&2; exit 1; }
[ -d "$wal_dir" ] || { echo "Каталог сегментов не найден: $wal_dir" >&2; exit 1; }
if ! printf '%s' "$target" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}(:?[0-9]{2})?$'; then
  echo "Момент времени задаётся как ГГГГ-ММ-ДД ЧЧ:ММ:СС+05 (с часовым поясом), получено: $target" >&2
  exit 2
fi
[ -d "$data" ] || { echo "Каталог данных не найден: $data" >&2; exit 1; }
if [ -n "$(find "$data" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "Каталог данных не пуст: $data. Восстановление идёт только в пустой каталог, прежние данные не трогаются." >&2
  exit 1
fi

umask 077
wal_restore="$data/wal-restore"
restore_path="${WAL_RESTORE_PATH:-$wal_restore}"

age -d -i "$BACKUP_IDENTITY" "$base" | tar -x -C "$data"
mkdir -p "$wal_restore"
count=0
for file in "$wal_dir"/*.age; do
  [ -e "$file" ] || continue
  name=$(basename "$file" .age)
  age -d -i "$BACKUP_IDENTITY" -o "$wal_restore/$name" "$file"
  count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "В каталоге $wal_dir нет сегментов журнала (*.age)" >&2; exit 1; }

# Настройки восстановления: журнал берётся из расшифрованного каталога, проигрывание останавливается на заданном
# моменте, база открывается на запись. Архив на время восстановления выключен: восстановленная база не должна
# писать сегменты поверх прежних.
cat >> "$data/postgresql.auto.conf" <<CONF
restore_command = 'cp $restore_path/%f %p'
recovery_target_time = '$target'
recovery_target_action = 'promote'
archive_mode = off
CONF
: > "$data/recovery.signal"

echo "Каталог данных готов: $data. Сегментов журнала: $count. Запустите базу на этом каталоге: она восстановится на $target."
