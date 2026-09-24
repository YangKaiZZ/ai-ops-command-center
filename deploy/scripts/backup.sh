#!/usr/bin/env bash
# Dumps the database to backups/ai_ops-<date>.sql.gz and keeps the newest 14.
# Run it from anywhere; cron example in the README.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups

file="backups/ai_ops-$(date +%Y%m%d-%H%M%S).sql.gz"
# A half-written dump is worse than none: delete it if anything fails.
trap 'rm -f "$file"' ERR

docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump --single-transaction --no-tablespaces -u "$MYSQL_USER" "$MYSQL_DATABASE"' \
  | gzip > "$file"

ls -1t backups/ai_ops-*.sql.gz | tail -n +15 | xargs -r rm --
echo "Saved $file"
