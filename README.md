# Mommy Knows — Telegram bot + Mini App (Cloudflare Workers, serverless)

One Worker = bot webhook + mini app website + API. Database = Cloudflare D1. Free tier is enough.

## Deploy (10 min)
1. @BotFather → /newbot → copy token and username.
2. In this folder:
   npm i
   npx wrangler login
   npx wrangler d1 create mommy-knows-db        # paste database_id into wrangler.toml
   npm run db:init
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET       # any random string, letters/digits only
3. Edit wrangler.toml: BOT_USERNAME, PUBLIC_URL (your workers.dev URL or custom domain).
4. npm run deploy
5. Open in browser once: https://YOUR_URL/setup?key=YOUR_WEBHOOK_SECRET
   (sets webhook, "Shop" menu button, commands)
6. Admin (5092483247) must press /start in the bot once, or Telegram won't deliver order alerts.

## How it works
- Customers: Shop button → cart → name/phone/address → order (cash on delivery). Prices: 59.99 AED/pack, set in src/index.js (PRODUCTS).
- Admin gets every order with buttons ✅ Confirm / 📦 Delivered / ❌ Cancel. Customer and agent are notified automatically.
- Agents: /agent or "Earn 10%" tab → personal code + 2 links:
    Telegram: https://t.me/BOT?start=CODE
    Website:  https://YOUR_URL/?ref=CODE
  A Telegram customer who comes via a link is tied to that agent permanently (all future orders pay commission).
  Website (non-Telegram) orders are attributed by the ref saved in that browser.
- Commission = 10% of the order, credited ONLY when admin marks it Delivered. Cancelled = 0. Agents can't earn on their own orders.
- Agent dashboard (mini app + /stats): clicks, customers, sales, earned, pending, paid, balance owed.
- Admin commands: /orders (open orders), /agents (who is owed what), /paid CODE AMOUNT (record payout, agent is notified).
