// Mommy Knows shop — Telegram bot + Mini App backend on Cloudflare Workers + D1.
// Money is handled in fils (integers). 5999 = 59.99 AED.
import indexHtml from '../public/index.html';
import { PANTS_L_IMG, PANTS_M_IMG, PANTS_XL_IMG, PANTS_XXL_IMG, PANTS_XXXL_IMG, TAPE_NB_IMG, TAPE_S_IMG, TAPE_M_IMG, TAPE_L_IMG, TAPE_XL_IMG, TAPE_XXL_IMG } from './product-images.js';
import { tg } from './telegram.js';
import { aed, esc, getAgent, getAgentByUser, orderText, adminButtons, notifyAdmin } from './common.js';
import { createGramQuote, buildPayWidgetMessage, handleWidgetQuery, pollGramPayments } from './gram.js';

// ---- Catalog: edit names / prices here (server-side prices are the only ones trusted) ----
const PRODUCTS = [
  { id: 'tp-nb',  name: 'Diapers Tape · NB',  sub: '2–5 kg · 68 pcs',  emoji: '👶', price: 5999, image: TAPE_NB_IMG,  category: 'Diaper Tape' },
  { id: 'tp-s',   name: 'Diapers Tape · S',   sub: '4–8 kg · 72 pcs',  emoji: '👶', price: 5999, image: TAPE_S_IMG,   category: 'Diaper Tape' },
  { id: 'tp-m',   name: 'Diapers Tape · M',   sub: '6–11 kg · 60 pcs', emoji: '👶', price: 5999, image: TAPE_M_IMG,   category: 'Diaper Tape' },
  { id: 'tp-l',   name: 'Diapers Tape · L',   sub: '9–14 kg · 52 pcs', emoji: '👶', price: 5999, image: TAPE_L_IMG,   category: 'Diaper Tape' },
  { id: 'tp-xl',  name: 'Diapers Tape · XL',  sub: '12–18 kg · 44 pcs', emoji: '👶', price: 5999, image: TAPE_XL_IMG, category: 'Diaper Tape' },
  { id: 'tp-xxl', name: 'Diapers Tape · XXL', sub: '15–22 kg · 42 pcs', emoji: '👶', price: 5999, image: TAPE_XXL_IMG, category: 'Diaper Tape' },
  { id: 'pt-m',   name: 'Diapers Pants · M',   sub: '6–11 kg · 52 pcs',  emoji: '🩲', price: 5999, image: PANTS_M_IMG,  category: 'Diaper Pants' },
  { id: 'pt-l',   name: 'Diapers Pants · L',   sub: '9–14 kg · 48 pcs',  emoji: '🩲', price: 5999, image: PANTS_L_IMG,  category: 'Diaper Pants' },
  { id: 'pt-xl',  name: 'Diapers Pants · XL',  sub: '12–18 kg · 44 pcs', emoji: '🩲', price: 5999, image: PANTS_XL_IMG, category: 'Diaper Pants' },
  { id: 'pt-xxl', name: 'Diapers Pants · XXL', sub: '15–22 kg · 42 pcs', emoji: '🩲', price: 5999, image: PANTS_XXL_IMG, category: 'Diaper Pants' },
  { id: 'pt-xxxl',name: 'Diapers Pants · XXXL',sub: '20–30 kg · 40 pcs', emoji: '🩲', price: 5999, image: PANTS_XXXL_IMG, category: 'Diaper Pants' },
];
const STATUSES = ['pending', 'confirmed', 'delivered', 'cancelled'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// ---------- Telegram Mini App initData validation ----------
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}
async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  const sig = [...(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400 * 7) return null; // stale
  return { user: JSON.parse(p.get('user') || 'null'), start_param: p.get('start_param') };
}

// ---------- DB helpers ----------
const randomCode = () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => a[b % a.length]).join('');
};
const cleanCode = (c) => (typeof c === 'string' && /^[A-Z0-9]{4,12}$/i.test(c) ? c.toUpperCase() : null);

async function upsertUser(env, u) {
  await env.DB.prepare(
    `INSERT INTO users (id, username, first_name) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET username = ?2, first_name = ?3`
  ).bind(u.id, u.username || null, u.first_name || null).run();
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first();
}

// First-touch attribution: once a customer is linked to an agent, it stays.
async function attachReferral(env, user, code) {
  code = cleanCode(code);
  if (!code || user.referred_by) return user.referred_by;
  const agent = await getAgent(env, code);
  if (!agent || agent.user_id === user.id) return null; // no self-referral
  await env.DB.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL').bind(code, user.id).run();
  return code;
}

async function becomeAgent(env, u) {
  let agent = await getAgentByUser(env, u.id);
  if (agent) return agent;
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const r = await env.DB.prepare('INSERT OR IGNORE INTO agents (code, user_id, name) VALUES (?, ?, ?)')
      .bind(code, u.id, [u.first_name, u.username && '@' + u.username].filter(Boolean).join(' ')).run();
    if (r.meta.changes) return getAgent(env, code);
  }
  throw new Error('could not create agent code');
}

async function agentStats(env, code) {
  const s = await env.DB.prepare(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'delivered')                      AS sales,
       COALESCE(SUM(commission) FILTER (WHERE status = 'delivered'), 0)  AS earned,
       COALESCE(SUM(commission) FILTER (WHERE status IN ('pending','confirmed')), 0) AS pending,
       COALESCE(SUM(total) FILTER (WHERE status = 'delivered'), 0)       AS revenue
     FROM orders WHERE agent_code = ?`
  ).bind(code).first();
  const paid = (await env.DB.prepare('SELECT COALESCE(SUM(amount),0) AS p FROM payouts WHERE agent_code = ?').bind(code).first()).p;
  const customers = (await env.DB.prepare('SELECT COUNT(*) AS c FROM users WHERE referred_by = ?').bind(code).first()).c;
  const clicks = (await env.DB.prepare('SELECT COALESCE(SUM(count),0) AS c FROM clicks WHERE agent_code = ?').bind(code).first()).c;
  return { ...s, paid, balance: s.earned - paid, customers, clicks };
}

function agentLinks(env, code) {
  return {
    telegram: `https://t.me/${env.BOT_USERNAME}?start=${code}`,
    web: `${env.PUBLIC_URL}/?ref=${code}`,
  };
}

// ---------- Orders ----------
async function createOrder(env, body, tgUser) {
  const items = [];
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const p = PRODUCTS.find((x) => x.id === it.id);
    const qty = Math.floor(Number(it.qty));
    if (p && qty > 0 && qty <= 100) items.push({ id: p.id, name: p.name, qty, price: p.price });
  }
  const name = String(body.name || '').trim().slice(0, 80);
  const phone = String(body.phone || '').trim().slice(0, 30);
  const address = String(body.address || '').trim().slice(0, 300);
  const note = String(body.note || '').trim().slice(0, 300);
  if (!items.length) return { error: 'Cart is empty' };
  if (!name || !address || !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return { error: 'Please fill name, valid phone and address' };

  const paymentMethod = body.payment_method === 'gram' ? 'gram' : 'cod';
  // The pay widget is delivered as a Telegram message, so GRAM only works for orders placed inside Telegram.
  if (paymentMethod === 'gram' && !tgUser) return { error: 'Pay with GRAM only works inside the Telegram app — open the bot, or choose cash on delivery' };

  let agentCode = null;
  if (tgUser) {
    const user = await upsertUser(env, tgUser);
    agentCode = await attachReferral(env, user, body.ref);
  } else {
    const c = cleanCode(body.ref);
    if (c && (await getAgent(env, c))) agentCode = c; // website order: ref from link only
  }

  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  const commission = agentCode ? Math.round((total * Number(env.COMMISSION_PERCENT || 10)) / 100) : 0;

  let quote = null;
  if (paymentMethod === 'gram') {
    try {
      quote = await createGramQuote(env, total);
    } catch (e) {
      console.error('gram quote failed', e.message);
      return { error: 'Could not get a live GRAM rate right now — please try again shortly, or choose cash on delivery' };
    }
  }

  const r = await env.DB.prepare(
    `INSERT INTO orders (user_id, customer_name, phone, address, note, items, total, agent_code, commission,
       payment_method, payment_status, gram_invoice_code, gram_amount_nanotons, gram_rate_aed, quote_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    tgUser?.id ?? null, name, phone, address, note, JSON.stringify(items), total, agentCode, commission,
    paymentMethod, quote ? 'awaiting' : null,
    quote?.invoiceCode ?? null, quote?.nanotons ?? null, quote?.rateAedPerGram ?? null, quote?.expiresAt ?? null,
  ).run();
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(r.meta.last_row_id).first();

  if (paymentMethod === 'gram') {
    // Admin/agent are only told once the payment actually clears on-chain (see gram.js) — an
    // unpaid, possibly-abandoned quote shouldn't trigger the same alert a real order does.
    await tg(env, 'sendWidget', buildPayWidgetMessage(order));
  } else {
    await notifyAdmin(env, order, tgUser);
    if (agentCode) {
      const agent = await getAgent(env, agentCode);
      await tg(env, 'sendMessage', {
        chat_id: agent.user_id,
        text: `🛒 New order #${order.id} from your customer — ${aed(total)}.\nYour commission ${aed(commission)} will be credited after delivery.`,
      });
    }
  }
  return { order };
}

async function setStatus(env, id, status, cq) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!o) return 'Order not found';
  if (o.status === 'delivered' || o.status === 'cancelled') return `Already ${o.status}`;
  await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, id).run();
  const updated = { ...o, status };
  const agent = o.agent_code ? await getAgent(env, o.agent_code) : null;

  if (cq) {
    await tg(env, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML',
      text: orderText(updated, null, agent),
      reply_markup: status === 'confirmed' ? adminButtons(id) : undefined,
    });
  }
  const msg = { confirmed: '✅ Your order #ID is confirmed. We will deliver soon.',
    delivered: '📦 Order #ID delivered. Thank you for choosing Mommy Knows!',
    cancelled: '❌ Order #ID was cancelled. Contact us if this is a mistake.' }[status];
  if (o.user_id) await tg(env, 'sendMessage', { chat_id: o.user_id, text: msg.replace('ID', id) });
  if (agent && status === 'delivered')
    await tg(env, 'sendMessage', { chat_id: agent.user_id, text: `💰 +${aed(o.commission)} commission credited (order #${id}).` });
  if (agent && status === 'cancelled')
    await tg(env, 'sendMessage', { chat_id: agent.user_id, text: `Order #${id} was cancelled — no commission.` });
  return `Order #${id} → ${status}`;
}

// ---------- Bot (webhook) ----------
const shopButton = (env) => ({
  inline_keyboard: [[{ text: '🛍 Open shop', web_app: { url: env.PUBLIC_URL } }]],
});

async function handleUpdate(env, update) {
  if (update.widget_query) return handleWidgetQuery(env, update.widget_query);

  if (update.callback_query) {
    const cq = update.callback_query;
    if (String(cq.from.id) !== String(env.ADMIN_ID)) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Admins only' });
    const [, id, status] = (cq.data || '').split(':');
    const text = STATUSES.includes(status) ? await setStatus(env, Number(id), status, cq) : 'Unknown action';
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  }

  const m = update.message;
  if (!m?.text || m.chat.type !== 'private') return;
  const user = await upsertUser(env, m.from);
  const [cmd, ...args] = m.text.trim().split(/\s+/);
  const isAdmin = String(m.from.id) === String(env.ADMIN_ID);
  const reply = (text, extra = {}) => tg(env, 'sendMessage', { chat_id: m.chat.id, text, parse_mode: 'HTML', ...extra });

  switch (cmd.split('@')[0]) {
    case '/start': {
      if (args[0]) {
        const code = await attachReferral(env, user, args[0]);
        if (code) await bumpClick(env, code);
      }
      return reply('Welcome to <b>Mommy Knows</b> 👶\nDiapers, wet wipes and napkins — <b>59.99 AED</b> per pack, cash on delivery.\n\nWant to earn? Send /agent to get your link and earn 10% on every sale.', { reply_markup: shopButton(env) });
    }
    case '/shop':
      return reply('Tap to open the shop 👇', { reply_markup: shopButton(env) });
    case '/agent': {
      const a = await becomeAgent(env, m.from);
      const l = agentLinks(env, a.code);
      return reply(`🤝 You are an agent. Code: <b>${a.code}</b>\n\nShare these links. Every customer who orders through them is yours forever — you get <b>${env.COMMISSION_PERCENT}%</b> of every delivered order.\n\nTelegram: ${l.telegram}\nWebsite: ${l.web}\n\n/stats — your earnings`, { disable_web_page_preview: true });
    }
    case '/stats': {
      const a = await getAgentByUser(env, m.from.id);
      if (!a) return reply('You are not an agent yet. Send /agent');
      const s = await agentStats(env, a.code);
      return reply(`📊 <b>Agent ${a.code}</b>\nLink clicks: ${s.clicks}\nCustomers: ${s.customers}\nDelivered sales: ${s.sales} (${aed(s.revenue)})\n\nEarned: <b>${aed(s.earned)}</b>\nPending (not delivered yet): ${aed(s.pending)}\nPaid out: ${aed(s.paid)}\n<b>Balance owed: ${aed(s.balance)}</b>`);
    }
    // ---- admin ----
    case '/orders': {
      if (!isAdmin) break;
      const { results } = await env.DB.prepare(`SELECT * FROM orders WHERE status IN ('pending','confirmed') ORDER BY id DESC LIMIT 20`).all();
      if (!results.length) return reply('No open orders.');
      for (const o of results) {
        const agent = o.agent_code ? await getAgent(env, o.agent_code) : null;
        await reply(orderText(o, null, agent), { reply_markup: adminButtons(o.id) });
      }
      return;
    }
    case '/agents': {
      if (!isAdmin) break;
      const { results } = await env.DB.prepare('SELECT * FROM agents ORDER BY created_at').all();
      if (!results.length) return reply('No agents yet.');
      const lines = [];
      for (const a of results) {
        const s = await agentStats(env, a.code);
        lines.push(`<b>${a.code}</b> ${esc(a.name)} — sales ${s.sales}, earned ${aed(s.earned)}, paid ${aed(s.paid)}, <b>owed ${aed(s.balance)}</b>`);
      }
      return reply(lines.join('\n') + '\n\nRecord a payout: /paid CODE AMOUNT');
    }
    case '/paid': {
      if (!isAdmin) break;
      const code = cleanCode(args[0]);
      const amount = Math.round(Number(args[1]) * 100);
      const a = code && (await getAgent(env, code));
      if (!a || !(amount > 0)) return reply('Usage: /paid CODE AMOUNT  (e.g. /paid AB12CD 50)');
      await env.DB.prepare('INSERT INTO payouts (agent_code, amount) VALUES (?, ?)').bind(code, amount).run();
      await tg(env, 'sendMessage', { chat_id: a.user_id, text: `💸 Payout of ${aed(amount)} sent to you. Thank you!` });
      const s = await agentStats(env, code);
      return reply(`Recorded ${aed(amount)} to ${code}. Remaining owed: ${aed(s.balance)}`);
    }
  }
  return reply(isAdmin
    ? 'Admin: /orders /agents /paid CODE AMOUNT\nUser: /shop /agent /stats'
    : '/shop — order\n/agent — become an agent\n/stats — your earnings', { reply_markup: shopButton(env) });
}

async function bumpClick(env, code) {
  if (!(await getAgent(env, code))) return;
  await env.DB.prepare(
    `INSERT INTO clicks (agent_code, day, count) VALUES (?, date('now'), 1)
     ON CONFLICT(agent_code, day) DO UPDATE SET count = count + 1`
  ).bind(code).run();
}

// ---------- HTTP router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === '/webhook' && req.method === 'POST') {
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
        const update = await req.json();
        ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error('update failed', e)));
        return new Response('ok');
      }

      // One-time setup: open https://YOUR_URL/setup?key=WEBHOOK_SECRET in a browser
      if (path === '/setup') {
        if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
        const res = {
          webhook: await tg(env, 'setWebhook', {
            url: `${env.PUBLIC_URL}/webhook`, secret_token: env.WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query', 'widget_query'], drop_pending_updates: true,
          }),
          menu: await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Shop', web_app: { url: env.PUBLIC_URL } } }),
          commands: await tg(env, 'setMyCommands', { commands: [
            { command: 'shop', description: 'Open the shop' },
            { command: 'agent', description: 'Become an agent — earn 10%' },
            { command: 'stats', description: 'My agent earnings' },
          ] }),
        };
        return json(res);
      }

      if (path === '/api/products') return json({ products: PRODUCTS, commission: Number(env.COMMISSION_PERCENT), bot: env.BOT_USERNAME });

      if (path === '/api/click' && req.method === 'POST') {
        const { ref } = await req.json().catch(() => ({}));
        const c = cleanCode(ref);
        if (c) await bumpClick(env, c);
        return json({ ok: true });
      }

      if (path.startsWith('/api/')) {
        const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
        const initData = req.headers.get('X-Init-Data') || '';
        const auth = await verifyInitData(initData, env.BOT_TOKEN);

        if (path === '/api/order' && req.method === 'POST') {
          // Outside Telegram (plain website) auth is null — order is still accepted, attributed by ?ref link.
          if (initData && !auth) return json({ error: 'Invalid session, reopen the app' }, 401);
          const ref = body.ref || auth?.start_param;
          const r = await createOrder(env, { ...body, ref }, auth?.user);
          if (r.error) return json(r, 400);
          const gram = r.order.payment_method === 'gram' ? {
            invoice_code: r.order.gram_invoice_code,
            gram_amount: Number(r.order.gram_amount_nanotons) / 1e9,
            expires_at: r.order.quote_expires_at,
          } : undefined;
          return json({ ok: true, id: r.order.id, total: r.order.total, payment_method: r.order.payment_method, gram });
        }

        if (!auth?.user) return json({ error: 'Open this inside Telegram' }, 401);

        if (path === '/api/me') {
          const user = await upsertUser(env, auth.user);
          if (auth.start_param) await attachReferral(env, user, auth.start_param);
          const { results: orders } = await env.DB.prepare('SELECT id, items, total, status, created_at FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 30').bind(user.id).all();
          const agent = await getAgentByUser(env, user.id);
          let agentData = null;
          if (agent) {
            const { results: sales } = await env.DB.prepare('SELECT id, total, commission, status, created_at FROM orders WHERE agent_code = ? ORDER BY id DESC LIMIT 50').bind(agent.code).all();
            agentData = { code: agent.code, links: agentLinks(env, agent.code), stats: await agentStats(env, agent.code), sales };
          }
          return json({ user: { id: user.id, first_name: user.first_name }, orders, agent: agentData });
        }

        if (path === '/api/agent' && req.method === 'POST') {
          await upsertUser(env, auth.user);
          const a = await becomeAgent(env, auth.user);
          return json({ ok: true, code: a.code });
        }
      }
    } catch (e) {
      console.error(e);
      return json({ error: 'Server error' }, 500);
    }
    if (req.method === 'GET') return new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollGramPayments(env).catch((e) => console.error('gram poll failed', e)));
  },
};
