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
STATUS_FILE="${GRIDVIS2MQTT_UPDATE_STATUS_FILE:-$DATA_DIR/update-status.json}"
OPERATION_ID="${GRIDVIS2MQTT_UPDATE_OPERATION_ID:-manual-$(date +%s)}"
TARGET_VERSION="${GRIDVIS2MQTT_UPDATE_TARGET_VERSION:-}"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
BEFORE_VERSION='unbekannt'

write_status() {
  local status="$1"
  local phase="$2"
  local progress="$3"
  local message="$4"
  local target="${5:-$TARGET_VERSION}"
  UPDATE_STATUS_FILE="$STATUS_FILE" \
  UPDATE_OPERATION_ID="$OPERATION_ID" \
  UPDATE_STATUS="$status" \
  UPDATE_PHASE="$phase" \
  UPDATE_PROGRESS="$progress" \
  UPDATE_MESSAGE="$message" \
  UPDATE_CURRENT_VERSION="$BEFORE_VERSION" \
  UPDATE_TARGET_VERSION="$target" \
  UPDATE_STARTED_AT="$STARTED_AT" \
  UPDATE_PID="$$" \
  node --input-type=module -e '
    import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const file = process.env.UPDATE_STATUS_FILE;
    let previous = {};
    try { previous = JSON.parse(readFileSync(file, "utf8")); } catch {}
    const numericProgress = Number(process.env.UPDATE_PROGRESS);
    const next = {
      ...previous,
      operationId: process.env.UPDATE_OPERATION_ID,
      status: process.env.UPDATE_STATUS,
      phase: process.env.UPDATE_PHASE,
      progress: Number.isFinite(numericProgress) ? Math.max(0, Math.min(100, numericProgress)) : 0,
      message: process.env.UPDATE_MESSAGE || "",
      currentVersion: process.env.UPDATE_CURRENT_VERSION || "unbekannt",
      targetVersion: process.env.UPDATE_TARGET_VERSION || "",
      startedAt: process.env.UPDATE_STARTED_AT,
      pid: Number(process.env.UPDATE_PID) || null,
      updatedAt: new Date().toISOString()
    };
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  ' || true
}

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

fail() {
  write_status error error 100 "$*"
  printf 'Fehler: %s\n' "$*" >&2
  exit 1
}

handle_error() {
  local code="$1"
  local line="$2"
  write_status error error 100 "Update fehlgeschlagen (Fehler in Zeile $line)."
  exit "$code"
}

trap 'handle_error "$?" "$LINENO"' ERR

start_seconds="$(date +%s)"
[[ -d "$INSTALL_DIR/.git" ]] || fail "Kein Git-Repository unter $INSTALL_DIR gefunden."
[[ -n "$NPM_BIN" ]] || fail 'npm wurde nicht gefunden.'

if ! git -C "$INSTALL_DIR" diff --quiet || ! git -C "$INSTALL_DIR" diff --cached --quiet; then
  fail 'Das Repository enthält lokale Änderungen. Bitte zuerst sichern oder committen.'
fi

backup_dir="$DATA_DIR/backups"
install -d -m 0700 "$backup_dir"
backup_file="$backup_dir/update-$(date '+%Y%m%d-%H%M%S').tar.gz"
BEFORE_VERSION="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || printf 'unbekannt')"
write_status running prepare 2 'Update wird vorbereitet ...' "$TARGET_VERSION"
log "Sicherung der Laufzeitdaten: $backup_file"
write_status running backup 10 'Laufzeitdaten werden gesichert ...' "$TARGET_VERSION"
tar --exclude='./backups' -C "$DATA_DIR" -czf "$backup_file" .
chmod 0600 "$backup_file"

log "Aktuelle Version: $BEFORE_VERSION"
log 'Remote-Änderungen werden geladen'
write_status running download 20 'Neue Release wird heruntergeladen ...' "$TARGET_VERSION"
git -C "$INSTALL_DIR" fetch --all --tags --prune --progress 2>&1 | while IFS= read -r line; do
  if [[ "$line" =~ ([0-9]{1,3})% ]]; then
    fetch_progress="${BASH_REMATCH[1]}"
    write_status running download "$((20 + fetch_progress * 25 / 100))" "Download läuft (${fetch_progress} %) ..." "$TARGET_VERSION"
  fi
done

upstream="$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
[[ -n "$upstream" ]] || fail 'Kein Upstream-Branch für das Repository eingerichtet.'
write_status running install 50 'Neue Release wird installiert ...' "$TARGET_VERSION"
git -C "$INSTALL_DIR" merge --ff-only "$upstream"

TARGET_VERSION="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || printf '%s' "$TARGET_VERSION")"
write_status running dependencies 60 'Produktionsabhängigkeiten werden aktualisiert ...' "$TARGET_VERSION"

log 'Produktionsabhängigkeiten werden aktualisiert'
(cd "$INSTALL_DIR" && "$NPM_BIN" ci --omit=dev --progress=true --loglevel=notice)

write_status running restart 82 "Dienst $SERVICE_NAME wird neu gestartet ..." "$TARGET_VERSION"
log "Dienst $SERVICE_NAME wird neu gestartet"
systemctl restart "$SERVICE_NAME.service"

if command -v curl >/dev/null 2>&1; then
  write_status running health 90 'Warte auf den Neustart der Webanwendung ...' "$TARGET_VERSION"
  for attempt in {1..30}; do
    if curl --fail --silent --show-error "http://127.0.0.1:$SERVICE_PORT/api/auth/status" >/dev/null; then
      after_version="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || printf 'unbekannt')"
      elapsed="$(( $(date +%s) - start_seconds ))"
      write_status success complete 100 "Update erfolgreich: $BEFORE_VERSION → $after_version (${elapsed}s)." "$after_version"
      log "Update erfolgreich: $BEFORE_VERSION -> $after_version (${elapsed}s)"
      exit 0
    fi
    sleep 1
  done
  fail "Dienst wurde neu gestartet, ist aber nicht erreichbar. Rollback-Sicherung: $backup_file"
fi

after_version="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || printf 'unbekannt')"
elapsed="$(( $(date +%s) - start_seconds ))"
write_status success complete 100 "Update abgeschlossen: $BEFORE_VERSION → $after_version (${elapsed}s)." "$after_version"
log "Update abgeschlossen: $BEFORE_VERSION -> $after_version (${elapsed}s)"
