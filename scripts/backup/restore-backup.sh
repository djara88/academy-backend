#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Uso: $0 <backup.tar.gz.enc> <backup.tar.gz.enc.sha256>"
  exit 1
fi

: "${BACKUP_PASSPHRASE:?Falta BACKUP_PASSPHRASE}"
: "${TARGET_SUPABASE_DB_URL:?Falta TARGET_SUPABASE_DB_URL}"
: "${TARGET_SUPABASE_URL:?Falta TARGET_SUPABASE_URL}"
: "${TARGET_SUPABASE_SERVICE_ROLE_KEY:?Falta TARGET_SUPABASE_SERVICE_ROLE_KEY}"

encrypted="$1"
checksum="$2"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

cp "$encrypted" "$checksum" "$workdir/"
cd "$workdir"
sha256sum -c "$(basename "$checksum")"

archive="${encrypted%.enc}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$(basename "$encrypted")" \
  -out "$(basename "$archive")" \
  -pass env:BACKUP_PASSPHRASE

tar -xzf "$(basename "$archive")"
cd backup
sha256sum -c meta/SHA256SUMS

psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file database/roles.sql \
  --file database/schema.sql \
  --command 'SET session_replication_role = replica' \
  --file database/data.sql \
  --dbname "$TARGET_SUPABASE_DB_URL"

# El historial de migraciones es útil para continuidad de Supabase CLI. En un
# proyecto nuevo puede requerir revisión si ya existe historial propio.
psql \
  --variable ON_ERROR_STOP=1 \
  --file database/history_schema.sql \
  --file database/history_data.sql \
  --dbname "$TARGET_SUPABASE_DB_URL" || echo "Aviso: revisar historial de migraciones manualmente."

BACKUP_STORAGE_DIR="$workdir/backup/storage" \
TARGET_SUPABASE_URL="$TARGET_SUPABASE_URL" \
TARGET_SUPABASE_SERVICE_ROLE_KEY="$TARGET_SUPABASE_SERVICE_ROLE_KEY" \
node "$GITHUB_WORKSPACE/scripts/backup/restore-storage.js"

psql "$TARGET_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
select 'academias' as entidad, count(*) from public.academias
union all select 'usuarios', count(*) from public.usuarios
union all select 'jugadores', count(*) from public.jugadores
union all select 'cobros', count(*) from public.cobros
union all select 'auth.users', count(*) from auth.users;
SQL

echo "Restauración lógica terminada. Validar Auth, Realtime, SMTP, URLs y una prueba funcional antes de cambiar producción."
