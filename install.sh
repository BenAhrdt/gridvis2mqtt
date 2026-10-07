#!/usr/bin/env bash
set -Eeuo pipefail

# Installiert GridVis2MQTT als systemd-Dienst. Das Skript wird aus einem
# geklonten Repository gestartet, kopiert aber keine lokalen Zugangsdaten.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${GRIDVIS2MQTT_INSTALL_DIR:-/opt/gridvis2mqtt}"
DATA_DIR="${GRIDVIS2MQTT_DATA_DIR:-/var/lib/gridvis2mqtt}"
SERVICE_NAME="${GRIDVIS2MQTT_SERVICE_NAME:-gridvis2mqtt}"
SERVICE_PORT="${GRIDVIS2MQTT_PORT:-8080}"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

fail() {
  printf 'Fehler: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "Bitte als root ausführen, zum Beispiel: sudo ./install.sh"
[[ -n "$NODE_BIN" ]] || fail 'Node.js wurde nicht gefunden. Benötigt wird Node.js >= 20.19.'
[[ -n "$NPM_BIN" ]] || fail 'npm wurde nicht gefunden.'
node_version_ok="$(node -p '(() => { const [major, minor] = process.versions.node.split(".").map(Number); return major > 20 || (major === 20 && minor >= 19); })()')"
[[ "$node_version_ok" == 'true' ]] || fail "Node.js >= 20.19 benötigt, gefunden wurde $(node --version)."

log "Installationsverzeichnis wird vorbereitet: $INSTALL_DIR"
install -d -m 0755 "$INSTALL_DIR"

if [[ "$(realpath -m "$SCRIPT_DIR")" != "$(realpath -m "$INSTALL_DIR")" ]]; then
  log 'Anwendungsdateien werden kopiert (lokale Daten und Zugangsdaten bleiben außen vor)'
  tar \
    --exclude='./node_modules' \
    --exclude='./data/config.local.json' \
    --exclude='./data/config.json' \
    --exclude='./data/state.local.json' \
    --exclude='./data/state.json' \
    --exclude='./data/auth.local.json' \
    --exclude='./data/auth.json' \
    --exclude='./data/update-status.json' \
    --exclude='./data/backups' \
    --exclude='./data/device-icons' \
    -C "$SCRIPT_DIR" -cf - . | tar -C "$INSTALL_DIR" -xf -
fi

log 'Produktionsabhängigkeiten werden installiert'
(cd "$INSTALL_DIR" && "$NPM_BIN" ci --omit=dev)

log "Datenverzeichnis wird eingerichtet: $DATA_DIR"
install -d -m 0750 "$DATA_DIR"
if [[ ! -e "$DATA_DIR/config.json" ]]; then
  printf '{}\n' > "$DATA_DIR/config.json"
fi
if [[ ! -e "$DATA_DIR/state.json" ]]; then
  printf '{}\n' > "$DATA_DIR/state.json"
fi
chmod 0600 "$DATA_DIR/config.json" "$DATA_DIR/state.json"

log 'systemd-Konfiguration wird geschrieben'
cat > "/etc/$SERVICE_NAME.env" <<EOF
NODE_ENV=production
GRIDVIS2MQTT_ALLOW_CONFIG_WRITE=true
PORT=$SERVICE_PORT
GRIDVIS2MQTT_INSTALL_DIR=$INSTALL_DIR
GRIDVIS2MQTT_DATA_DIR=$DATA_DIR
GRIDVIS2MQTT_CONFIG_FILE=$DATA_DIR/config.json
GRIDVIS2MQTT_STATE_FILE=$DATA_DIR/state.json
GRIDVIS2MQTT_AUTH_FILE=$DATA_DIR/auth.json
GRIDVIS2MQTT_ICON_CACHE_DIR=$DATA_DIR/device-icons
EOF
chmod 0644 "/etc/$SERVICE_NAME.env"

cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=GridVis2MQTT
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=/etc/$SERVICE_NAME.env
ExecStart=$NODE_BIN $INSTALL_DIR/src/server.js
Restart=on-failure
RestartSec=5
# Web-Updates laufen als detached Prozess weiter, während systemd den Dienst
# neu startet. Der Update-Prozess schreibt seinen Status in die Datenablage.
KillMode=process
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service"
systemctl restart "$SERVICE_NAME.service"

log "Dienst $SERVICE_NAME wurde gestartet"
if command -v curl >/dev/null 2>&1; then
  for attempt in {1..20}; do
    if curl --fail --silent --show-error "http://127.0.0.1:$SERVICE_PORT/api/auth/status" >/dev/null; then
      log "GridVis2MQTT ist erreichbar: http://127.0.0.1:$SERVICE_PORT"
      exit 0
    fi
    sleep 1
  done
  fail "Dienst läuft nicht innerhalb des erwarteten Zeitraums. Details: systemctl status $SERVICE_NAME"
fi

log "Installation abgeschlossen. URL: http://127.0.0.1:$SERVICE_PORT"
