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

async function pushWidgetState(env, o) {
  if (!o.user_id || !o.gram_widget_message_id) return;
  await tg(env, 'editMessageWidgetData', {
    chat_id: o.user_id, message_id: o.gram_widget_message_id, chat_data: JSON.stringify(widgetState(o)),
  });
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
    await pushWidgetState(env, o);
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
      const q = await quoteAmount(env, o.total);
      await env.DB.prepare(
        "UPDATE orders SET payment_status = 'awaiting', gram_amount_nanotons = ?, gram_rate_aed = ?, quote_expires_at = ?, gram_claimed_msg_hash = NULL WHERE id = ?"
      ).bind(q.nanotons, q.rateAedPerGram, q.expiresAt, o.id).run();
    } catch (e) {
      console.error('gram requote failed', e.message);
      return reply('Could not get a live price right now. Try again in a moment.');
    }
    return reply();
  }

  if (action === 'cod' && open) {
    await env.DB.prepare("UPDATE orders SET payment_method = 'cod', payment_status = NULL WHERE id = ?").bind(o.id).run();
    o = await getOrder(env, o.id);
    await notifyAdmin(env, o, wq.from);
    await notifyAgentOfOrder(env, o, '');
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
  const admin = (text) => tg(env, 'sendMessage', { chat_id: env.ADMIN_ID, text });
  const o = await env.DB.prepare('SELECT * FROM orders WHERE gram_invoice_code = ?').bind(comment).first();

  if (!o) return admin(`⚠️ Unmatched GRAM payment: ${formatNanotons(got)} GRAM from ${sender}, comment "${comment}" matches no order.\ntx ${txHash}`);
  if (o.payment_method !== 'gram') return admin(`⚠️ GRAM payment for order #${o.id}, which the customer switched to cash on delivery: ${formatNanotons(got)} GRAM from ${sender}. Refund it or treat the order as prepaid.\ntx ${txHash}`);
  if (o.payment_status === 'paid' || o.payment_status === 'overpaid') return admin(`⚠️ Duplicate GRAM payment for order #${o.id} (already paid): ${formatNanotons(got)} GRAM from ${sender}. Needs a manual refund.\ntx ${txHash}`);
  if (o.payment_status !== 'awaiting' && o.payment_status !== 'expired') return admin(`⚠️ Another GRAM payment for order #${o.id} (status "${o.payment_status}"): ${formatNanotons(got)} GRAM from ${sender}. Review manually.\ntx ${txHash}`);

  const expected = BigInt(o.gram_amount_nanotons);
  const seen = { paid_amount_nanotons: got.toString(), tx_hash: txHash };
  let problem;
  // Judge lateness by when the transaction happened on-chain, not by when we polled.
  if (txn.now * 1000 > new Date(o.quote_expires_at).getTime()) {
    await markOrder(env, o.id, 'late', seen);
    problem = `⏰ Late GRAM payment for order #${o.id}: ${formatNanotons(got)} GRAM from ${sender} arrived after the quote expired (quoted ${formatNanotons(expected)}). Honor it or refund.\ntx ${txHash}`;
  } else if (got < expected) {
    await markOrder(env, o.id, 'underpaid', seen);
    problem = `⚠️ Underpaid GRAM order #${o.id}: expected ${formatNanotons(expected)} GRAM, got ${formatNanotons(got)} from ${sender}. Ask for the rest or refund.\ntx ${txHash}`;
  } else {
    await markOrder(env, o.id, got > expected ? 'overpaid' : 'paid', { ...seen, paid_at: new Date().toISOString() });
  }

  const fresh = await getOrder(env, o.id);
  await pushWidgetState(env, fresh);
  if (problem) return admin(problem);

  await notifyAdmin(env, fresh, null); // the same "new order" card a cash order gets at once, sent only now that it is paid
  await admin(`💎 GRAM payment for order #${fresh.id}: ${formatNanotons(got)} GRAM (${aed(fresh.total)}) from ${sender}.\ntx ${txHash}`);
  await tg(env, 'sendMessage', { chat_id: fresh.user_id, text: `✅ Payment received for order #${fresh.id}. We'll get it ready for delivery!` });
  await notifyAgentOfOrder(env, fresh, ' (paid with GRAM)');
  if (got > expected) await admin(`💸 Order #${fresh.id} was overpaid by ${formatNanotons(got - expected)} GRAM. Refund the difference to ${sender}.\ntx ${txHash}`);
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
    await saveCursor(txn.lt, txn.hash);
  }
}
