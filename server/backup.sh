#!/usr/bin/env bash
# Snapshot diario do banco. O VACUUM INTO e executado pelo proprio sqld, que e
# quem detem o WAL: copiar o arquivo por fora enquanto ele escreve pode gerar
# uma copia inconsistente que so aparece no dia em que voce precisar dela.
set -euo pipefail

DEST=${NOC_BACKUP_DIR:-/var/backups/noc}
KEEP_DAYS=${NOC_BACKUP_KEEP_DAYS:-14}
SQLD=${NOC_SQLD_URL:-http://127.0.0.1:8080}
ARQUIVO="$DEST/updown-$(date +%Y-%m-%d).db"

mkdir -p "$DEST"
rm -f "$ARQUIVO" "$ARQUIVO.gz"

RESPOSTA=$(curl -sf "$SQLD/v2/pipeline" -H 'Content-Type: application/json' \
  -d "{\"requests\":[{\"type\":\"execute\",\"stmt\":{\"sql\":\"VACUUM INTO '$ARQUIVO'\"}},{\"type\":\"close\"}]}")

if printf '%s' "$RESPOSTA" | grep -q '"type":"error"'; then
  echo "backup: sqld recusou o VACUUM INTO -> $RESPOSTA" >&2
  exit 1
fi

# Uma copia que nunca foi verificada nao e um backup, e uma esperanca.
if [ "$(sqlite3 "$ARQUIVO" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "backup: copia gerada esta corrompida" >&2
  exit 1
fi

gzip -f "$ARQUIVO"
find "$DEST" -name 'updown-*.db.gz' -mtime "+$KEEP_DAYS" -delete
echo "backup ok: $ARQUIVO.gz ($(du -h "$ARQUIVO.gz" | cut -f1))"
