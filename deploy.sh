#!/usr/bin/env bash
# One-shot deploy. Usage:  BOT_TOKEN=123:ABC bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${BOT_TOKEN:?Run as: BOT_TOKEN=your_token bash deploy.sh}"

echo "== Checking bot token"
BOT_USERNAME=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getMe" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(!j.ok){console.error("Bad token: "+j.description);process.exit(1)}console.log(j.result.username)})')
echo "   bot: @$BOT_USERNAME"

npm i --silent
npx wrangler whoami >/dev/null || { echo "Not logged in: run npx wrangler login"; exit 1; }

echo "== Database"
if grep -q REPLACE_WITH_ID wrangler.toml; then
  DB_ID=$(npx wrangler d1 list --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const x=JSON.parse(d).find(b=>b.name==="mommy-knows-db");console.log(x?x.uuid:"")})')
  if [ -z "$DB_ID" ]; then
    npx wrangler d1 create mommy-knows-db >/dev/null
    DB_ID=$(npx wrangler d1 list --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).find(b=>b.name==="mommy-knows-db").uuid))')
  fi
  sed -i.bak "s/REPLACE_WITH_ID_FROM_wrangler_d1_create/$DB_ID/" wrangler.toml
fi
npx wrangler d1 execute mommy-knows-db --remote --file=schema.sql -y >/dev/null
sed -i.bak "s/^BOT_USERNAME = .*/BOT_USERNAME = \"$BOT_USERNAME\"/" wrangler.toml

echo "== First deploy (to get URL)"
URL=$(npx wrangler deploy 2>&1 | tee /dev/stderr | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | grep -v '^https://REPLACE' | tail -1)
[ -n "$URL" ] || { echo "Could not detect workers.dev URL"; exit 1; }
sed -i.bak "s#^PUBLIC_URL = .*#PUBLIC_URL = \"$URL\"#" wrangler.toml

echo "== Secrets"
SECRET=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
printf '%s' "$BOT_TOKEN" | npx wrangler secret put BOT_TOKEN >/dev/null
printf '%s' "$SECRET"    | npx wrangler secret put WEBHOOK_SECRET >/dev/null

echo "== Final deploy"
npx wrangler deploy >/dev/null
sleep 5
echo "== Telegram setup"
curl -s "$URL/setup?key=$SECRET"; echo
rm -f wrangler.toml.bak

echo
echo "DONE"
echo "Mini app / website: $URL"
echo "Bot:                https://t.me/$BOT_USERNAME"
echo "Admin: open the bot and press /start so order alerts can reach you."
