#!/usr/bin/env bash
# Ресурсы сервера для сигналов дежурным (план M9, задача 9, решение 17; ТЗ 13.8 "диск, память, процессор").
# Агента хостинга нет: таймер systemd раз в 5 минут запускает этот сценарий (docs/runbooks/launch.md, раздел 12).
# Сценарий только читает: доли занятого места томов базы и копий (наибольшую), памяти без кеша и нагрузки процессора
# за минуту на одно ядро, и передаёт их порталу командой hub ops:host-mark. Сигналы host_pressure и host_mark_stale
# шлёт фоновый процесс. Путей томов и имён устройств сценарий не печатает.
#
# Настройки окружения (у всех есть значения по умолчанию):
#   HUB_DIR             каталог портала с compose.prod.yaml, по умолчанию /opt/smartup-hub
#   HOST_WATCH_PATHS    тома через пробел, по умолчанию том базы Docker и каталог копий
#   HOST_WATCH_MEMINFO  по умолчанию /proc/meminfo
#   HOST_WATCH_LOADAVG  по умолчанию /proc/loadavg
#   HOST_WATCH_NPROC    число ядер, по умолчанию nproc
set -euo pipefail

HUB_DIR="${HUB_DIR:-/opt/smartup-hub}"
PATHS="${HOST_WATCH_PATHS:-/var/lib/docker/volumes /var/backups/smartup-hub}"
MEMINFO="${HOST_WATCH_MEMINFO:-/proc/meminfo}"
LOADAVG="${HOST_WATCH_LOADAVG:-/proc/loadavg}"
CPUS="${HOST_WATCH_NPROC:-$(nproc)}"

# shellcheck disable=SC2086 # тома передаются отдельными аргументами
disk=$(df -P $PATHS | awk 'NR > 1 { v = $5; sub("%", "", v); if (v + 0 > m) m = v + 0 } END { printf "%d", m }')
mem=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2; seen = 1 } END { if (t > 0 && seen) printf "%d", ((t - a) * 100 / t) + 0.5; else exit 1 }' "$MEMINFO") || {
  echo "Не разобрана доля памяти: отметка не отправлена" >&2
  exit 1
}
cpu=$(awk -v n="$CPUS" 'NR == 1 { if (n < 1) exit 1; p = int($1 * 100 / n + 0.5); if (p > 100) p = 100; printf "%d", p }' "$LOADAVG") || {
  echo "Не разобрана нагрузка процессора: отметка не отправлена" >&2
  exit 1
}
for value in "$disk" "$mem" "$cpu"; do
  if ! [[ "$value" =~ ^[0-9]{1,3}$ ]] || [ "$value" -gt 100 ]; then
    echo "Доля вне 0-100: отметка не отправлена" >&2
    exit 1
  fi
done

host=$(hostname | tr 'A-Z' 'a-z')
if ! docker compose -f "$HUB_DIR/compose.prod.yaml" exec -T web node hub.mjs ops:host-mark --host "$host" --disk "$disk" --mem "$mem" --cpu "$cpu"; then
  echo "Отметка ресурсов не записана (hub ops:host-mark): через 15 минут дежурные получат сигнал host_mark_stale" >&2
  exit 1
fi
