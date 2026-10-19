#!/usr/bin/env bash
# Allybot Health Check Watchdog (Lapis 3 Anti-Zombie)
# Runs via systemd timer to detect hung sockets and auto-heal.
set -euo pipefail

HEALTH_URL="http://127.0.0.1:18088/health"

# If allybot is not active, do not interfere
if ! systemctl is-active --quiet allybot.service; then
  exit 0
fi

MAIN_PID=$(systemctl show -p MainPID --value allybot.service 2>/dev/null || echo "0")
if [ -z "$MAIN_PID" ] || [ "$MAIN_PID" -eq 0 ]; then
  exit 0
fi

UPTIME=$(ps -o etimes= -p "$MAIN_PID" 2>/dev/null | tr -d ' ' || echo "0")
if [ -z "$UPTIME" ]; then
  UPTIME=0
fi

# Probe health endpoint
RESP=$(curl -s -m 5 "$HEALTH_URL" || true)

if [ -z "$RESP" ]; then
  if [ "$UPTIME" -lt 120 ]; then
    exit 0 # Still initializing
  fi
  echo "[$(date -Iseconds)] Watchdog: Web companion unresponsive after ${UPTIME}s uptime. Restarting allybot.service..."
  systemctl restart allybot.service
  exit 0
fi

# Extract JSON values without heavy dependencies
OK=$(echo "$RESP" | grep -o '"ok":true' || true)
STATUS=$(echo "$RESP" | grep -o '"status":"[^"]*"' | cut -d':' -f2 | tr -d '"' || echo "unknown")

if [ "$OK" = '"ok":true' ]; then
  exit 0
fi

# If session needs auth (unlinked), do not spam restart to avoid WhatsApp rate limits
if [ "$STATUS" = "needs_auth" ]; then
  echo "[$(date -Iseconds)] Watchdog: Allybot session requires re-authentication (needs_auth). Auto-restart suppressed."
  exit 0
fi

# If connecting or reconnecting and within early grace period, wait
if [ "$UPTIME" -lt 120 ] && { [ "$STATUS" = "connecting" ] || [ "$STATUS" = "reconnecting" ]; }; then
  exit 0
fi

# Transient jitter filter: sleep 10s and re-probe
sleep 10
RECHECK=$(curl -s -m 5 "$HEALTH_URL" || true)
RECHECK_OK=$(echo "$RECHECK" | grep -o '"ok":true' || true)

if [ "$RECHECK_OK" = '"ok":true' ]; then
  exit 0
fi

RECHECK_STATUS=$(echo "$RECHECK" | grep -o '"status":"[^"]*"' | cut -d':' -f2 | tr -d '"' || echo "unknown")
if [ "$RECHECK_STATUS" = "needs_auth" ]; then
  echo "[$(date -Iseconds)] Watchdog: Allybot session requires re-authentication (needs_auth). Auto-restart suppressed."
  exit 0
fi

echo "[$(date -Iseconds)] Watchdog: Allybot unhealthy (status: $STATUS -> $RECHECK_STATUS, uptime: ${UPTIME}s). Restarting allybot.service..."
systemctl restart allybot.service
