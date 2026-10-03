#!/bin/sh
# Run a throwaway cell from the fork image the way fleet runs a cell, on 127.0.0.1:19104.
set -eu
IMG=localhost:5000/urbicana/agent:dev
NAME=urbicana-proof
STATE="$HOME/.openclaw/fleet/cells/$NAME"
SECRETS="$HOME/.openclaw/fleet/auth-profile-secrets/$NAME"
TOKEN_FILE="$HOME/.openclaw/fleet/$NAME.token"
umask 077
mkdir -p "$STATE" "$SECRETS"
[ -s "$TOKEN_FILE" ] || printf 'proof-%s' "$(openssl rand -hex 12)" > "$TOKEN_FILE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker network inspect "$NAME-net" >/dev/null 2>&1 || docker network create "$NAME-net" >/dev/null
docker run -d --name "$NAME" --user 501:20 --workdir /app \
  --network "$NAME-net" -p 127.0.0.1:19104:18789 \
  --memory 2g --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges \
  -e HOME=/home/node -e OPENCLAW_HOME=/home/node/.openclaw -e OPENCLAW_STATE_DIR=/home/node/.openclaw \
  -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json -e OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace \
  -e XDG_CACHE_HOME=/home/node/.openclaw/cache -e OPENCLAW_GATEWAY_TOKEN="$(cat "$TOKEN_FILE")" \
  -v "$STATE:/home/node/.openclaw" -v "$SECRETS:/home/node/.config/openclaw" \
  --entrypoint tini "$IMG" -s -- node /app/docker-entrypoint.mjs node dist/index.js gateway --bind lan --port 18789 >/dev/null
n=0; until [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:19104/healthz)" = "200" ] || [ $n -ge 60 ]; do sleep 3; n=$((n+1)); done
echo "healthz: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:19104/healthz) after ~$((n*3))s"
