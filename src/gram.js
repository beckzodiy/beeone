// GRAM (TON) payments.
//
// The shop (catalogue, address form) is the Mini App. When the customer picks
// GRAM, checkout moves into the chat: the bot sends a Telegram HTML widget
// (Bot API 10.4: sendWidget / widget_query / answerWidgetQuery /
// editMessageWidgetData) that shows the order and drives the user's built-in
// Gram Wallet. No TON Connect manifest, bridge or SDK: the widget sandbox has
// no network access, and Telegram's wallet takes TON Connect's request format.
//
// The widget's "sent_transaction" notification is NEVER proof of payment
// (Telegram's own docs say so). Only pollGramPayments() marks an order paid,
// after finding a transaction with our invoice code as its comment and the
// right amount on the merchant wallet through the TON Center API.
import { beginCell, Address } from '@ton/core';
import { tg } from './telegram.js';
import { aed, esc, getAgent, notifyAdmin } from './common.js';

const FINAL_PAID = ['paid', 'overpaid'];

const INVOICE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomInvoiceCode = () =>
  [...crypto.getRandomValues(new Uint8Array(6))].map((b) => INVOICE_ALPHABET[b % INVOICE_ALPHABET.length]).join('');

// How long after the quote's expiry a "payment sent" claim keeps the widget in its waiting state.
const SENT_GRACE_MS = 120_000;

// A TON text comment: uint32 zero opcode + UTF-8 text, as a base64 BOC.
function commentPayloadBase64(text) {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell().toBoc().toString('base64');
}

function assertMerchantAddress(env) {
  try {
    Address.parse(env.GRAM_MERCHANT_ADDRESS);
  } catch {
    throw new Error(`GRAM_MERCHANT_ADDRESS is not a valid TON address: "${env.GRAM_MERCHANT_ADDRESS}"`);
  }
}

// AED per 1 GRAM. Tried in order until one answers; if none does, the caller
// refuses the quote. Several sources because the public price APIs rate-limit
// Cloudflare's shared IPs (CoinGecko and TonAPI both return 429 from a Worker).
// The exchange tickers are in USDT: converted at the dirham's fixed USD peg.
const AED_PER_USD = 3.6725;
const RATE_SOURCES = [
  ['https://api.coinbase.com/v2/exchange-rates?currency=TON', (j) => j?.data?.rates?.AED],
  ['https://www.okx.com/api/v5/market/ticker?instId=TON-USDT', (j) => j?.data?.[0]?.last * AED_PER_USD],
  ['https://api.bybit.com/v5/market/tickers?category=spot&symbol=TONUSDT', (j) => j?.result?.list?.[0]?.lastPrice * AED_PER_USD],
  ['https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=TON-USDT', (j) => j?.data?.price * AED_PER_USD],
  ['https://tonapi.io/v2/rates?tokens=ton&currencies=aed', (j) => j?.rates?.TON?.prices?.AED],
  ['https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=aed', (j) => j?.['the-open-network']?.aed],
];

async function fetchGramRateAed() {
  const errors = [];
  for (const [url, pick] of RATE_SOURCES) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mommy-knows-shop/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rate = Number(pick(await r.json()));
      if (rate > 0) return rate;
      throw new Error('no AED rate in response');
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e.message}`);
    }
  }
  throw new Error('no rate source answered: ' + errors.join('; '));
}

// Prices `totalFils` in GRAM at the live rate and locks it for GRAM_QUOTE_MINUTES.
// Throws if the rate can't be fetched: never guess a rate.
async function quoteAmount(env, totalFils) {
  assertMerchantAddress(env);
  const rateAedPerGram = await fetchGramRateAed();
  const nanotons = String(Math.round((totalFils / 100 / rateAedPerGram) * 1e9));
  const expiresAt = new Date(Date.now() + Number(env.GRAM_QUOTE_MINUTES || 10) * 60_000).toISOString();
  return { nanotons, rateAedPerGram, expiresAt };
}

export async function createGramQuote(env, totalFils) {
  const quote = await quoteAmount(env, totalFils);
  for (let i = 0; i < 5; i++) {
    const invoiceCode = randomInvoiceCode();
    if (!(await env.DB.prepare('SELECT 1 FROM orders WHERE gram_invoice_code = ?').bind(invoiceCode).first())) {
      return { ...quote, invoiceCode };
    }
  }
  throw new Error('could not allocate a unique GRAM invoice code');
}

const gramText = (nanotons) => (Number(nanotons) / 1e9).toFixed(4);

function formatNanotons(n) {
  const v = BigInt(n);
  return `${v / 1_000_000_000n}.${(v % 1_000_000_000n).toString().padStart(9, '0').slice(0, 4)}`;
}

// ---------- The widget's state (written only by the bot, as chat_data) ----------
function widgetState(o) {
  if (o.payment_method !== 'gram') return { s: 'cod' };
  const g = gramText(o.gram_amount_nanotons);
  if (o.payment_status === 'paid' || o.payment_status === 'overpaid') return { s: 'paid', g: gramText(o.paid_amount_nanotons || o.gram_amount_nanotons) };
  if (o.payment_status !== 'awaiting' && o.payment_status !== 'expired') return { s: 'review' };
  const exp = new Date(o.quote_expires_at).getTime();
  if (o.gram_claimed_msg_hash && Date.now() < exp + SENT_GRACE_MS) return { s: 'sent', g };
  return { s: 'awaiting', g, exp };
}

// Push the order's payment state to whichever checkout the customer has in the chat.
async function pushCheckoutState(env, o) {
  if (!o.user_id) return;
  if (o.gram_widget_message_id) {
    await tg(env, 'editMessageWidgetData', {
      chat_id: o.user_id, message_id: o.gram_widget_message_id, chat_data: JSON.stringify(widgetState(o)),
    });
  }
  if (o.gram_pay_message_id) {
    await tg(env, 'editMessageText', { chat_id: o.user_id, message_id: o.gram_pay_message_id, ...payMessage(env, o) });
  }
}

// ---------- Fallback checkout: a plain message ----------
// Used when Telegram refuses the widget (sendWidget -> INPUT_MEDIA_WIDGET_NOT_ALLOWED).
// The customer pays from any TON wallet by address + amount + comment; the
// poller matches it on-chain exactly as for the widget.
const exactGram = (n) => { const v = BigInt(n); return `${v / 1_000_000_000n}.${(v % 1_000_000_000n).toString().padStart(9, '0')}`.replace(/\.?0+$/, ''); };
const friendly = (addr) => { try { return Address.parse(addr).toString({ bounceable: false }); } catch { return addr; } };
const tonkeeperLink = (to, nanotons, text) =>
  `https://app.tonkeeper.com/transfer/${friendly(to)}?amount=${nanotons}&text=${encodeURIComponent(text)}`;

function transferButtons(to, nanotons, comment, payLabel) {
  return [
    [{ text: payLabel, url: tonkeeperLink(to, nanotons, comment) }],
    [{ text: 'Copy address', copy_text: { text: friendly(to) } },
     { text: 'Copy amount', copy_text: { text: exactGram(nanotons) } },
     { text: 'Copy comment', copy_text: { text: comment } }],
  ];
}

function payMessage(env, o) {
  const head = `💎 <b>Order #${o.id}</b> — ${aed(o.total)}`;
  const st = widgetState(o).s;
  if (o.payment_status === 'refunded') return { parse_mode: 'HTML', text: `${head}\n\n💸 Your GRAM payment was refunded.` };
  if (st === 'paid') return { parse_mode: 'HTML', text: `${head}\n\n✅ <b>Paid ${exactGram(o.paid_amount_nanotons)} GRAM.</b> Thank you! We are preparing your delivery.` };
  if (st === 'cod') return { parse_mode: 'HTML', text: `${head}\n\n💵 Switched to <b>cash on delivery</b>. Pay the courier when it arrives.` };
  if (st === 'review') return { parse_mode: 'HTML', text: `${head}\n\n⚠️ We received a payment that does not match this order. We will contact you.` };
  const exp = new Date(o.quote_expires_at);
  const cash = [{ text: '💵 Pay cash on delivery instead', callback_data: `gc:${o.gram_invoice_code}` }];
  if (exp.getTime() <= Date.now()) {
    return { parse_mode: 'HTML', text: `${head}\n\n⏰ The GRAM price has expired. Get a new price to pay.`,
      reply_markup: { inline_keyboard: [[{ text: '🔄 Get a new price', callback_data: `gn:${o.gram_invoice_code}` }], cash] } };
  }
  const hhmm = exp.toISOString().slice(11, 16);
  return {
    parse_mode: 'HTML',
    text: `${head}\n\nSend exactly <b>${exactGram(o.gram_amount_nanotons)} GRAM</b>\nto <code>${friendly(env.GRAM_MERCHANT_ADDRESS)}</code>\nwith comment <code>${o.gram_invoice_code}</code>\n\n`
      + `⚠️ The comment is required, without it we cannot match your payment.\nPrice valid until ${hhmm} UTC. We confirm automatically about a minute after you pay.`,
    reply_markup: { inline_keyboard: [
      ...transferButtons(env.GRAM_MERCHANT_ADDRESS, o.gram_amount_nanotons, o.gram_invoice_code, '💎 Pay in Tonkeeper'),
      [{ text: '🔄 Check status', callback_data: `gs:${o.gram_invoice_code}` }],
      cash,
    ] },
  };
}

// Opens the GRAM checkout in the customer's chat as a Telegram widget. No other checkout:
// if Telegram refuses the widget, the order is not placed.
export async function sendGramCheckout(env, order) {
  const w = await tg(env, 'sendWidget', buildPayWidgetMessage(order));
  if (!w.ok) return false;
  await env.DB.prepare('UPDATE orders SET gram_widget_message_id = ? WHERE id = ?').bind(w.result.message_id, order.id).run();
  return true;
}

async function requote(env, o) {
  const q = await quoteAmount(env, o.total);
  await env.DB.prepare(
    "UPDATE orders SET payment_status = 'awaiting', gram_amount_nanotons = ?, gram_rate_aed = ?, quote_expires_at = ?, gram_claimed_msg_hash = NULL WHERE id = ?"
  ).bind(q.nanotons, q.rateAedPerGram, q.expiresAt, o.id).run();
}

async function switchToCod(env, o, from) {
  await env.DB.prepare("UPDATE orders SET payment_method = 'cod', payment_status = NULL WHERE id = ?").bind(o.id).run();
  const fresh = await getOrder(env, o.id);
  await notifyAdmin(env, fresh, from);
  await notifyAgentOfOrder(env, fresh, '');
}

// Buttons under the fallback message (customer) and the refund buttons (admin).
// Returns the toast text, or undefined if the callback is not ours.
export async function handleGramCallback(env, cq) {
  const [action, arg] = String(cq.data || '').split(':');
  const isAdmin = String(cq.from.id) === String(env.ADMIN_ID);
  if (action === 'rf' || action === 'rfo') return isAdmin ? refundInstructions(env, action, Number(arg)) : 'Admins only';
  if (!['gc', 'gn', 'gs'].includes(action)) return undefined;

  let o = await env.DB.prepare('SELECT * FROM orders WHERE gram_invoice_code = ?').bind(arg).first();
  if (!o || o.user_id !== cq.from.id) return 'Order not found';
  const open = o.payment_method === 'gram' && (o.payment_status === 'awaiting' || o.payment_status === 'expired');
  let toast = '';
  if (action === 'gc' && open) { await switchToCod(env, o, cq.from); toast = 'Switched to cash on delivery'; }
  if (action === 'gn' && open) {
    try { await requote(env, o); toast = 'New price locked'; } catch (e) { console.error('gram requote failed', e.message); toast = 'Could not get a live price, try again'; }
  }
  if (action === 'gs') toast = FINAL_PAID.includes(o.payment_status) ? 'Paid ✅' : 'Not received yet. It can take a minute after you pay.';
  o = await getOrder(env, o.id);
  await tg(env, 'editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, ...payMessage(env, o) });
  return toast || 'Updated';
}

// ---------- Refunds ----------
// The bot never sends funds: a refund is a ready-made transfer the admin sends
// from their own wallet. The poller then sees the outgoing transfer with
// comment "Refund #N" and marks the refund done.
async function createRefund(env, { orderId = null, to, nanotons, reason, sourceTx = null }) {
  const r = await env.DB.prepare(
    'INSERT INTO gram_refunds (order_id, to_address, amount_nanotons, reason, source_tx_hash) VALUES (?, ?, ?, ?, ?)'
  ).bind(orderId, to, String(nanotons), reason, sourceTx).run();
  return r.meta.last_row_id;
}

const refundButton = (id, nanotons) => ({ inline_keyboard: [[{ text: `💸 Refund ${exactGram(nanotons)} GRAM`, callback_data: `rf:${id}` }]] });

async function refundInstructions(env, action, id) {
  let refund;
  if (action === 'rfo') {
    const o = await getOrder(env, id);
    if (!o || o.payment_method !== 'gram' || !FINAL_PAID.includes(o.payment_status)) return 'Nothing to refund';
    if (!o.gram_payer_address) return 'Payer address unknown for this order, refund manually';
    refund = await env.DB.prepare("SELECT * FROM gram_refunds WHERE order_id = ? AND reason = 'order refund'").bind(id).first();
    if (!refund) {
      const rid = await createRefund(env, { orderId: id, to: o.gram_payer_address, nanotons: o.paid_amount_nanotons, reason: 'order refund', sourceTx: o.tx_hash });
      refund = await env.DB.prepare('SELECT * FROM gram_refunds WHERE id = ?').bind(rid).first();
    }
  } else {
    refund = await env.DB.prepare('SELECT * FROM gram_refunds WHERE id = ?').bind(id).first();
  }
  if (!refund) return 'Refund not found';
  if (refund.status === 'sent') return 'Already refunded ✅';
  const comment = `Refund #${refund.id}`;
  await tg(env, 'sendMessage', {
    chat_id: env.ADMIN_ID, parse_mode: 'HTML',
    text: `💸 <b>Refund #${refund.id}</b>${refund.order_id ? ` — order #${refund.order_id}` : ''} (${esc(refund.reason)})\n\n`
      + `From the shop wallet, send <b>${exactGram(refund.amount_nanotons)} GRAM</b>\nto <code>${friendly(refund.to_address)}</code>\nwith comment <code>${comment}</code>\n\n`
      + `Keep the comment: that is how the bot sees the refund went out and tells the customer. The bot never sends funds itself.`,
    reply_markup: { inline_keyboard: transferButtons(refund.to_address, refund.amount_nanotons, comment, '💸 Send in Tonkeeper') },
  });
  return 'Refund details sent';
}

async function processOutgoingTransaction(env, txn) {
  for (const m of txn.out_msgs || []) {
    const match = /^Refund #(\d+)\b/.exec((m.message_content?.decoded?.comment || '').trim());
    if (!match) continue;
    const refund = await env.DB.prepare('SELECT * FROM gram_refunds WHERE id = ?').bind(Number(match[1])).first();
    if (!refund || refund.status === 'sent') continue;
    const admin = (text) => tg(env, 'sendMessage', { chat_id: env.ADMIN_ID, text });
    let sameDest = false;
    try { sameDest = Address.parse(m.destination).equals(Address.parse(refund.to_address)); } catch {}
    if (!sameDest || BigInt(m.value || '0') < BigInt(refund.amount_nanotons)) {
      await admin(`⚠️ Refund #${refund.id}: a transfer with its comment went out, but to ${friendly(m.destination)} for ${exactGram(m.value || '0')} GRAM, not ${exactGram(refund.amount_nanotons)} GRAM to ${friendly(refund.to_address)}. Not marked as refunded.\ntx ${txn.hash}`);
      continue;
    }
    await env.DB.prepare("UPDATE gram_refunds SET status = 'sent', tx_hash = ?, sent_at = ? WHERE id = ?")
      .bind(txn.hash, new Date().toISOString(), refund.id).run();
    await admin(`✅ Refund #${refund.id} sent: ${exactGram(m.value)} GRAM to ${friendly(refund.to_address)}.\ntx ${txn.hash}`);
    if (!refund.order_id) continue;
    const o = await getOrder(env, refund.order_id);
    if (refund.reason === 'order refund') await env.DB.prepare("UPDATE orders SET payment_status = 'refunded' WHERE id = ?").bind(o.id).run();
    if (o?.user_id) await tg(env, 'sendMessage', { chat_id: o.user_id, text: `💸 We refunded ${exactGram(m.value)} GRAM for order #${o.id} to your wallet.\ntx ${txn.hash}` });
  }
}

const getOrder = (env, id) => env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();

// ---------- The widget itself ----------
// The HTML is fixed once sent; everything that changes comes from chat_data.
// Kept free of backticks and ${ so it can live in this template literal.
function widgetHtml(o) {
  const rows = JSON.parse(o.items).map((i) =>
    `<div class=r><span>${esc(i.name)} × ${i.qty}</span><span>${aed(i.qty * i.price)}</span></div>`).join('');
  return `<style>
.r{display:flex;justify-content:space-between;gap:12px}
.m{color:var(--tg-theme-hint-color);font-size:.85em}
.g{font-size:1.6em;font-weight:700;margin-top:6px}
button{width:100%;margin-top:8px}
.l{background:none;color:var(--tg-theme-link-color)}
hr{margin:8px 0}
</style>
<b>Order #${o.id}</b>
${rows}
<hr>
<div class=r><b>Total</b><b>${aed(o.total)}</b></div>
<div class=m>Delivery: ${esc(o.address)}</div>
<div id=v></div>
<script>
var W=TelegramWidget,C=${JSON.stringify(o.gram_invoice_code)},v=document.getElementById('v'),S={},busy=0,note='';
function read(){try{S=JSON.parse(W.chatData)||{}}catch(e){S={}}}
function left(){return (S.exp||0)-Date.now()}
function clock(){var l=Math.max(0,left()),s=Math.floor(l%60000/1000);return Math.floor(l/60000)+':'+(s<10?'0':'')+s}
function btn(id,text,cls){return '<button id='+id+(cls?' class='+cls:'')+(busy?' disabled':'')+'>'+text+'</button>'}
function render(){
  var h='',s=S.s;
  if(s==='paid')h='<p><b>✅ Paid '+S.g+' GRAM</b><br><span class=m>Thank you! We are preparing your delivery.</span></p>';
  else if(s==='cod')h='<p><b>💵 Cash on delivery</b><br><span class=m>Order confirmed. Pay the courier when it arrives.</span></p>';
  else if(s==='review')h='<p><b>⚠️ Payment needs a manual check</b><br><span class=m>We received a payment that does not match this order. We will contact you.</span></p>';
  else if(s==='sent')h='<div class=g>'+S.g+' GRAM</div><p class=m>⏳ Payment sent. Confirming on the blockchain, usually about a minute.</p>'+btn('k','Check status','l');
  else if(s==='awaiting'){
    h='<div class=g>'+S.g+' GRAM</div>';
    if(left()>0){
      h+='<div class=m>Price locked for <span id=t>'+clock()+'</span></div>';
      h+=W.wallet?btn('p','Pay with Wallet'):'<p class=m>Telegram Wallet is not available in this app. Update Telegram or pay cash.</p>';
    }else h+='<div class=m>This price has expired.</div>'+btn('n','Get a new price');
    h+=btn('c','Pay cash on delivery instead','l');
  }
  if(note)h+='<div class=m>'+note+'</div>';
  v.innerHTML=h;
}
function take(a){
  var r=null;try{r=JSON.parse(a&&a.result)}catch(e){}
  if(r&&r.st)S=r.st;
  note=r&&r.err||'';
  return r;
}
function why(e){
  var c=e&&e.code;
  return c==='REJECTED'?'Cancelled in the wallet.':c==='BAD_REQUEST'?'The wallet refused this payment. Get a new price and try again.':c==='TIMEOUT'?'No answer yet. If you already paid, do not pay again: tap Check status.':'Something went wrong. Please try again.';
}
function run(p){busy=1;note='Please wait…';render();p.then(null,function(e){note=why(e)}).then(function(){busy=0;render()})}
v.onclick=function(e){
  var id=e.target&&e.target.id;
  if(busy||!id)return;
  if(id==='p')run(W.request('pay:'+C,{wallet:true}).then(function(a){
    var r=take(a);
    if(!r||!r.messages)return;
    note='Confirm the payment in your wallet…';render();
    return W.wallet.sendTransaction(r,'paid:'+C).then(take);
  }));
  else if(id==='n')run(W.request('new:'+C).then(take));
  else if(id==='c')run(W.request('cod:'+C).then(take));
  else if(id==='k')run(W.request('st:'+C).then(take));
};
W.onEvent('chatDataChanged',function(){read();if(!busy)note='';render()});
setInterval(function(){
  if(S.s!=='awaiting'||busy)return;
  var t=document.getElementById('t');
  if(t&&left()>0)t.textContent=clock();else if(t)render();
},1000);
read();render();W.ready&&W.ready();
</script>`;
}

export function buildPayWidgetMessage(order) {
  return {
    chat_id: order.user_id,
    html: widgetHtml(order),
    chat_data: JSON.stringify(widgetState(order)),
    allow_queries: true,
  };
}

// ---------- Requests from the widget ----------
// Never marks an order paid: only pollGramPayments() does, against the chain.
export async function handleWidgetQuery(env, wq) {
  const answer = (data) => tg(env, 'answerWidgetQuery', { widget_query_id: wq.id, data: JSON.stringify(data) });
  const [action, code] = String(wq.data || '').split(':');
  let o = code && (await env.DB.prepare('SELECT * FROM orders WHERE gram_invoice_code = ?').bind(code).first());
  // `from` is authenticated by Telegram; only the customer who placed the order may act on it.
  if (!o || o.user_id !== wq.from?.id) return answer({ err: 'Order not found.' });

  const open = o.payment_method === 'gram' && (o.payment_status === 'awaiting' || o.payment_status === 'expired');
  const reply = async (err) => {
    o = await getOrder(env, o.id);
    await pushCheckoutState(env, o);
    return answer({ st: widgetState(o), ...(err ? { err } : {}) });
  };

  if (wq.type?.type === 'sent_transaction') {
    if (open) await env.DB.prepare('UPDATE orders SET gram_claimed_msg_hash = ? WHERE id = ?').bind(wq.type.msg_hash || '?', o.id).run();
    return reply();
  }

  if (action === 'pay') {
    const expiresAtMs = new Date(o.quote_expires_at).getTime();
    if (open && expiresAtMs <= Date.now()) {
      await env.DB.prepare("UPDATE orders SET payment_status = 'expired' WHERE id = ?").bind(o.id).run();
      return reply('This price has expired. Get a new price.');
    }
    if (!open || o.gram_claimed_msg_hash) return reply();
    return answer({
      valid_until: Math.floor(expiresAtMs / 1000),
      messages: [{ address: env.GRAM_MERCHANT_ADDRESS, amount: o.gram_amount_nanotons, payload: commentPayloadBase64(o.gram_invoice_code) }],
    });
  }

  if (action === 'new' && open) {
    try {
      await requote(env, o);
    } catch (e) {
      console.error('gram requote failed', e.message);
      return reply('Could not get a live price right now. Try again in a moment.');
    }
    return reply();
  }

  if (action === 'cod' && open) {
    await switchToCod(env, o, wq.from);
    return reply();
  }

  return reply(); // 'st' and anything that no longer applies: just report the current state
}

async function notifyAgentOfOrder(env, o, how) {
  const agent = o.agent_code && (await getAgent(env, o.agent_code));
  if (!agent) return;
  await tg(env, 'sendMessage', {
    chat_id: agent.user_id,
    text: `🛒 New order #${o.id} from your customer — ${aed(o.total)}${how}.\nYour commission ${aed(o.commission)} will be credited after delivery.`,
  });
}

// ---------- On-chain verification ----------
async function markOrder(env, id, paymentStatus, fields) {
  const cols = Object.keys(fields);
  await env.DB.prepare(`UPDATE orders SET payment_status = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`)
    .bind(paymentStatus, ...cols.map((c) => fields[c]), id).run();
}

async function processIncomingTransaction(env, txn) {
  const msg = txn.in_msg;
  const comment = (msg?.message_content?.decoded?.comment || '').trim();
  if (!comment) return; // not a text-comment transfer: nothing to match on

  const got = BigInt(msg.value || '0');
  const txHash = txn.hash;
  const sender = msg.source || 'unknown';
  const payer = friendly(sender);
  const admin = (text, extra = {}) => tg(env, 'sendMessage', { chat_id: env.ADMIN_ID, text, ...extra });
  // Flag to the admin with a one-tap refund of `amount` back to the sender.
  const flag = async (text, orderId, amount, reason) => {
    const rid = await createRefund(env, { orderId, to: sender, nanotons: amount, reason, sourceTx: txHash });
    return admin(text, { reply_markup: refundButton(rid, amount) });
  };
  const o = await env.DB.prepare('SELECT * FROM orders WHERE gram_invoice_code = ?').bind(comment).first();

  if (!o) return flag(`⚠️ Unmatched GRAM payment: ${formatNanotons(got)} GRAM from ${payer}, comment "${comment}" matches no order.\ntx ${txHash}`, null, got, 'unmatched payment');
  if (o.payment_method !== 'gram') return flag(`⚠️ GRAM payment for order #${o.id}, which the customer switched to cash on delivery: ${formatNanotons(got)} GRAM from ${payer}. Refund it, or treat the order as prepaid.\ntx ${txHash}`, o.id, got, 'paid after switching to cash');
  if (o.payment_status !== 'awaiting' && o.payment_status !== 'expired') return flag(`⚠️ Duplicate GRAM payment for order #${o.id} (status "${o.payment_status}"): ${formatNanotons(got)} GRAM from ${payer}.\ntx ${txHash}`, o.id, got, 'duplicate payment');

  const expected = BigInt(o.gram_amount_nanotons);
  const seen = { paid_amount_nanotons: got.toString(), tx_hash: txHash, gram_payer_address: payer };
  let problem;
  // Judge lateness by when the transaction happened on-chain, not by when we polled.
  if (txn.now * 1000 > new Date(o.quote_expires_at).getTime()) {
    await markOrder(env, o.id, 'late', seen);
    problem = [`⏰ Late GRAM payment for order #${o.id}: ${formatNanotons(got)} GRAM from ${payer} arrived after the quote expired (quoted ${formatNanotons(expected)}). Honor it (confirm the order) or refund.\ntx ${txHash}`, 'late payment'];
  } else if (got < expected) {
    await markOrder(env, o.id, 'underpaid', seen);
    problem = [`⚠️ Underpaid GRAM order #${o.id}: expected ${formatNanotons(expected)} GRAM, got ${formatNanotons(got)} from ${payer}. Ask for the rest or refund.\ntx ${txHash}`, 'underpaid'];
  } else {
    await markOrder(env, o.id, got > expected ? 'overpaid' : 'paid', { ...seen, paid_at: new Date().toISOString() });
  }

  const fresh = await getOrder(env, o.id);
  await pushCheckoutState(env, fresh);
  if (problem) return flag(problem[0], o.id, got, problem[1]);

  await notifyAdmin(env, fresh, null); // the same "new order" card a cash order gets at once, sent only now that it is paid
  await admin(`💎 GRAM payment for order #${fresh.id}: ${formatNanotons(got)} GRAM (${aed(fresh.total)}) from ${payer}.\ntx ${txHash}`);
  await tg(env, 'sendMessage', { chat_id: fresh.user_id, text: `✅ Payment received for order #${fresh.id}. We'll get it ready for delivery!` });
  await notifyAgentOfOrder(env, fresh, ' (paid with GRAM)');
  if (got > expected) await flag(`💸 Order #${fresh.id} was overpaid by ${formatNanotons(got - expected)} GRAM.\ntx ${txHash}`, fresh.id, got - expected, 'overpayment');
}

// Runs every minute (cron trigger in wrangler.toml). Reads the merchant
// wallet's new incoming transactions and matches them to orders by on-chain
// comment and amount.
//
// Uses TON Center's v3 (indexed) API: v2 is a direct liteserver call and
// fails with "lt not in db" once a transaction ages out of a non-archival
// node. The lt cursor makes this idempotent: each transaction is processed
// once, in order.
export async function pollGramPayments(env) {
  const headers = env.TONCENTER_API_KEY ? { 'X-API-Key': env.TONCENTER_API_KEY } : {};
  const state = await env.DB.prepare('SELECT * FROM gram_poll_state WHERE id = 1').first();
  const saveCursor = (lt, hash) =>
    env.DB.prepare('UPDATE gram_poll_state SET last_lt = ?, last_hash = ? WHERE id = 1').bind(lt, hash).run();

  const url = new URL(env.TONCENTER_BASE_URL + '/transactions');
  url.searchParams.set('account', env.GRAM_MERCHANT_ADDRESS);
  if (!state?.last_lt) {
    // First run ever: start from the wallet's current tip, don't process old history.
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('limit', '1');
  } else {
    url.searchParams.set('sort', 'asc');
    url.searchParams.set('limit', '50');
    url.searchParams.set('start_lt', (BigInt(state.last_lt) + 1n).toString());
  }

  const r = await fetch(url, { headers });
  if (!r.ok) { console.error('gram poll: toncenter http', r.status, await r.text()); return; }
  const txs = (await r.json()).transactions || [];

  if (!state?.last_lt) return saveCursor(txs[0]?.lt ?? '0', txs[0]?.hash ?? '');
  for (const txn of txs) {
    await processIncomingTransaction(env, txn);
    await processOutgoingTransaction(env, txn);
    await saveCursor(txn.lt, txn.hash);
  }
}
