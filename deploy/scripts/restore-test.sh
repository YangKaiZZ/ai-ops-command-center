#!/usr/bin/env bash
# Checks that a backup really restores, without touching the live data: loads
# it into a scratch database (restore_check), prints the rows in each table
# next to the live database's, then drops the scratch database.
#   scripts/restore-test.sh                 the newest backup
#   scripts/restore-test.sh backups/x.gz    that one
set -euo pipefail
cd "$(dirname "$0")/.."

file="${1:-$(ls -1t backups/ai_ops-*.sql.gz 2>/dev/null | head -n 1 || true)}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "No backup found (looked in backups/). Run scripts/backup.sh first."
  exit 1
fi

# mysql as root inside the container, with the given arguments.
as_root() {
  docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -u root "$@"' sh "$@"
}

live_db=$(docker compose exec -T mysql printenv MYSQL_DATABASE </dev/null | tr -d '\r')
trap 'as_root -e "DROP DATABASE IF EXISTS restore_check" </dev/null || true' EXIT

as_root -e "DROP DATABASE IF EXISTS restore_check; CREATE DATABASE restore_check" </dev/null
gunzip -c "$file" | as_root restore_check

tables=$(as_root -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema = 'restore_check' ORDER BY table_name" </dev/null | tr -d '\r')
if [ -z "$tables" ]; then
  echo "FAILED: $file restored no tables."
  exit 1
fi

query=""
for t in $tables; do
  [ -n "$query" ] && query="$query UNION ALL "
  query="${query}SELECT '$t', (SELECT COUNT(*) FROM restore_check.\`$t\`), (SELECT COUNT(*) FROM \`$live_db\`.\`$t\`)"
done

echo "Restored $file into a scratch database."
echo "Rows per table: in the backup / in the live database now (they differ by whatever changed since):"
as_root -N -e "$query" </dev/null | tr -d '\r' | while IFS=$'\t' read -r name in_backup live; do
  printf "  %-24s %8s / %s\n" "$name" "$in_backup" "$live"
done
echo "OK: the backup restores. The scratch database is dropped now; the live one wasn't touched."
