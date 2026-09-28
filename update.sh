#!/usr/bin/env bash
set -Eeuo pipefail

# Aktualisiert eine Installation aus dem Git-Repository und zeigt Fortschritt
# sowie Laufzeit an. Daten liegen außerhalb des Repositorys und werden vor dem
# Update zusätzlich als Rollback-Sicherung archiviert.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${GRIDVIS2MQTT_ENV_FILE:-/etc/gridvis2mqtt.env}"
if [[ -r "$ENV_FILE" ]]; then
  # Die Installationsdatei enthält ausschließlich Pfade und Laufzeitwerte.
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

INSTALL_DIR="${GRIDVIS2MQTT_INSTALL_DIR:-$SCRIPT_DIR}"
DATA_DIR="${GRIDVIS2MQTT_DATA_DIR:-$INSTALL_DIR/data}"
SERVICE_NAME="${GRIDVIS2MQTT_SERVICE_NAME:-gridvis2mqtt}"
SERVICE_PORT="${GRIDVIS2MQTT_PORT:-8080}"
NPM_BIN="$(command -v npm || true)"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

fail() {
  printf 'Fehler: %s\n' "$*" >&2
  exit 1
}

start_seconds="$(date +%s)"
[[ -d "$INSTALL_DIR/.git" ]] || fail "Kein Git-Repository unter $INSTALL_DIR gefunden."
[[ -n "$NPM_BIN" ]] || fail 'npm wurde nicht gefunden.'

if ! git -C "$INSTALL_DIR" diff --quiet || ! git -C "$INSTALL_DIR" diff --cached --quiet; then
  fail 'Das Repository enthält lokale Änderungen. Bitte zuerst sichern oder committen.'
fi

backup_dir="$DATA_DIR/backups"
install -d -m 0700 "$backup_dir"
backup_file="$backup_dir/update-$(date '+%Y%m%d-%H%M%S').tar.gz"
log "Sicherung der Laufzeitdaten: $backup_file"
tar --exclude='./backups' -C "$DATA_DIR" -czf "$backup_file" .
chmod 0600 "$backup_file"

before_version="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || printf 'unbekannt')"
log "Aktuelle Version: $before_version"
log 'Remote-Änderungen werden geprüft'
git -C "$INSTALL_DIR" fetch --all --tags --prune
git -C "$INSTALL_DIR" pull --ff-only

log 'Produktionsabhängigkeiten werden aktualisiert'
(cd "$INSTALL_DIR" && "$NPM_BIN" ci --omit=dev)

log "Dienst $SERVICE_NAME wird neu gestartet"
systemctl restart "$SERVICE_NAME.service"

if command -v curl >/dev/null 2>&1; then
  for attempt in {1..30}; do
    if curl --fail --silent --show-error "http://127.0.0.1:$SERVICE_PORT/api/auth/status" >/dev/null; then
      after_version="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || printf 'unbekannt')"
      elapsed="$(( $(date +%s) - start_seconds ))"
      log "Update erfolgreich: $before_version -> $after_version (${elapsed}s)"
      exit 0
    fi
    sleep 1
  done
  fail "Dienst wurde neu gestartet, ist aber nicht erreichbar. Rollback-Sicherung: $backup_file"
fi

after_version="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || printf 'unbekannt')"
elapsed="$(( $(date +%s) - start_seconds ))"
log "Update abgeschlossen: $before_version -> $after_version (${elapsed}s)"
