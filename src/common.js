// Small helpers shared between index.js and gram.js.
import { tg } from './telegram.js';

export const aed = (f) => (f / 100).toFixed(2) + ' AED';
export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export const getAgent = (env, code) => env.DB.prepare('SELECT * FROM agents WHERE code = ?').bind(code).first();
export const getAgentByUser = (env, uid) => env.DB.prepare('SELECT * FROM agents WHERE user_id = ?').bind(uid).first();

export function orderText(o, tgUser, agent) {
  const items = JSON.parse(o.items).map((i) => `• ${esc(i.name)} × ${i.qty} = ${aed(i.qty * i.price)}`).join('\n');
  const paymentLine = o.payment_method === 'gram'
    ? `<b>Total: ${aed(o.total)}</b> (paid with GRAM${o.tx_hash ? ` — tx ${esc(o.tx_hash.slice(0, 10))}…` : ''})`
    : `<b>Total: ${aed(o.total)}</b> (cash on delivery)`;
  return [
    `🧾 <b>Order #${o.id}</b> — <b>${o.status.toUpperCase()}</b>`,
    items,
    paymentLine,
    '',
    `👤 ${esc(o.customer_name)}${tgUser?.username ? ' (@' + esc(tgUser.username) + ')' : ''}`,
    `📞 ${esc(o.phone)}`,
    `📍 ${esc(o.address)}`,
    o.note ? `📝 ${esc(o.note)}` : '',
    agent ? `🤝 Agent: ${esc(agent.name)} [${agent.code}] — commission ${aed(o.commission)}` : '🤝 No agent',
    o.user_id ? '' : '🌐 Ordered from website (not Telegram)',
  ].filter((l) => l !== '').join('\n');
}

export const adminButtons = (id) => ({
  inline_keyboard: [[
    { text: '✅ Confirm', callback_data: `st:${id}:confirmed` },
    { text: '📦 Delivered', callback_data: `st:${id}:delivered` },
    { text: '❌ Cancel', callback_data: `st:${id}:cancelled` },
  ]],
});

export async function notifyAdmin(env, o, tgUser) {
  const agent = o.agent_code ? await getAgent(env, o.agent_code) : null;
  await tg(env, 'sendMessage', {
    chat_id: env.ADMIN_ID, parse_mode: 'HTML', text: orderText(o, tgUser, agent), reply_markup: adminButtons(o.id),
  });
}
