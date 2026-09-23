#!/usr/bin/env bash
# Einmalige Einrichtung bzw. Umstellung auf GitHub-Updates.
# Aufruf auf dem VPS:  sudo bash setup.sh
# Kann gefahrlos mehrfach ausgeführt werden. Statistik und Admin-Schlüssel bleiben erhalten.
set -euo pipefail

REPO_URL="https://github.com/StrikerLUL/passt-it-zu-mir.fun.git"
BRANCH="main"
APP_DIR="/opt/passt-it-zu-mir"          # Git-Klon (gehört www-data, damit der Dienst sich selbst updaten darf)
DATA_DIR="/var/lib/passt-it-zu-mir"     # Statistik – außerhalb des Repos, wird von Updates nie angefasst
ENV_FILE="/etc/passt-it-zu-mir.env"     # Schlüssel – nur für root lesbar
SERVICE_FILE="/etc/systemd/system/fisi-quiz.service"
OLD_DIR="/opt/fisi-quiz"

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausführen: sudo bash setup.sh"; exit 1; }
cd /   # www-data darf /root nicht lesen – sonst bricht git ab
command -v git  >/dev/null || apt-get install -y git
command -v node >/dev/null || { echo "Node.js fehlt – bitte zuerst installieren (v18+)."; exit 1; }
NODE_BIN="$(command -v node)"

echo "== 1/5 Code von GitHub holen"
if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$APP_DIR"; chown www-data:www-data "$APP_DIR"
  sudo -u www-data git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  chown -R www-data:www-data "$APP_DIR"
  sudo -u www-data git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u www-data git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
fi
echo "   Stand: $(sudo -u www-data git -C "$APP_DIR" log -1 --format='%h – %s')"

echo "== 2/5 Datenordner"
mkdir -p "$DATA_DIR"
if [ -f "$OLD_DIR/data/stats.json" ] && [ ! -f "$DATA_DIR/stats.json" ]; then
  cp "$OLD_DIR/data/stats.json" "$DATA_DIR/stats.json"; echo "   bisherige Statistik übernommen"
fi
chown -R www-data:www-data "$DATA_DIR"

echo "== 3/5 Schlüssel"
get_old() { { grep -hoP "^(Environment=)?$1=\K.*" "$ENV_FILE" "$SERVICE_FILE" 2>/dev/null || true; } | head -1; }
ADMIN_KEY="$(get_old ADMIN_KEY)";           [ -n "$ADMIN_KEY" ]      || ADMIN_KEY="$(openssl rand -hex 16)"
WEBHOOK_SECRET="$(get_old WEBHOOK_SECRET)"; [ -n "$WEBHOOK_SECRET" ] || WEBHOOK_SECRET="$(openssl rand -hex 24)"
umask 077
cat > "$ENV_FILE" <<ENV
PORT=3847
HOST=127.0.0.1
BRANCH=$BRANCH
DATA_DIR=$DATA_DIR
ADMIN_KEY=$ADMIN_KEY
WEBHOOK_SECRET=$WEBHOOK_SECRET
ENV
echo "$ADMIN_KEY"      > /root/fisi-quiz-admin-key.txt
echo "$WEBHOOK_SECRET" > /root/fisi-quiz-webhook-secret.txt
umask 022
echo "   Admin-Schlüssel:  /root/fisi-quiz-admin-key.txt"
echo "   Webhook-Secret:   /root/fisi-quiz-webhook-secret.txt"

echo "== 4/5 Dienst"
cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=Passt IT zu mir – Messe-Quiz
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR/server
ExecStart=$NODE_BIN server.js
EnvironmentFile=$ENV_FILE
User=www-data
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --quiet fisi-quiz
systemctl reset-failed fisi-quiz 2>/dev/null || true
systemctl restart fisi-quiz

echo "== 5/5 Test"
sleep 2
echo "   Dienst: $(systemctl is-active fisi-quiz)"
curl -s http://127.0.0.1:3847/api/version; echo
