// GRAM (TON) payments.
//
// Architecture: Telegram's native HTML widgets (Bot API 10.4, sendWidget /
// widget_query / answerWidgetQuery) drive the user's own built-in Gram
// Wallet — no TON Connect manifest, no bridge, no SDK in the widget (the
// widget sandbox has zero network access and can't load one anyway).
//
// The widget's "sent_transaction" notification is NEVER trusted as proof of
// payment (Telegram's own docs say so explicitly). The only thing that marks
// an order paid is pollGramPayments() finding a matching transaction — right
// payload (our invoice code as the on-chain comment) and right amount —
// actually on the merchant wallet, via the TON Center API.
import { beginCell, Address } from '@ton/core';
import { tg } from './telegram.js';
import { aed, esc, getAgent, notifyAdmin } from './common.js';

const INVOICE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomInvoiceCode = () =>
  [...crypto.getRandomValues(new Uint8Array(6))].map((b) => INVOICE_ALPHABET[b % INVOICE_ALPHABET.length]).join('');

// TON "simple message" text comment: a cell whose body is a uint32 zero
// opcode followed by the UTF-8 text, serialized to BOC and base64-encoded —
// this is the standard payload format TON Connect's `sendTransaction` (and
// every TON wallet) expects for a plain-text transfer comment.
function commentPayloadBase64(text) {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell().toBoc().toString('base64');
}

async function fetchGramRateAed(env) {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=aed');
  if (!r.ok) throw new Error(`CoinGecko rate fetch failed: HTTP ${r.status}`);
  const j = await r.json();
  const rate = j?.['the-open-network']?.aed;
  if (!(rate > 0)) throw new Error('CoinGecko response missing AED rate for the-open-network');
  return rate; // AED per 1 GRAM
}

function nanotonsForFils(fils, rateAedPerGram) {
  const gramAmount = fils / 100 / rateAedPerGram;
  const nanotons = Math.round(gramAmount * 1e9);
  return { nanotons: String(nanotons), gramAmount };
}

function assertMerchantAddress(env) {
  try {
    Address.parse(env.GRAM_MERCHANT_ADDRESS);
  } catch {
    throw new Error(`GRAM_MERCHANT_ADDRESS is not a valid TON address: "${env.GRAM_MERCHANT_ADDRESS}" — set it in wrangler.toml`);
  }
}

// Locks a quote for `GRAM_QUOTE_MINUTES` (default 10) and allocates a unique
// on-chain invoice code. Throws if the live rate can't be fetched — the
// caller should fall back to offering cash on delivery, never guess a rate.
export async function createGramQuote(env, totalFils) {
  assertMerchantAddress(env);
  const rateAedPerGram = await fetchGramRateAed(env);
  const { nanotons, gramAmount } = nanotonsForFils(totalFils, rateAedPerGram);

  let invoiceCode;
  for (let i = 0; i < 5 && !invoiceCode; i++) {
    const candidate = randomInvoiceCode();
    const exists = await env.DB.prepare('SELECT 1 FROM orders WHERE gram_invoice_code = ?').bind(candidate).first();
    if (!exists) invoiceCode = candidate;
  }
  if (!invoiceCode) throw new Error('could not allocate a unique GRAM invoice code');

  const minutes = Number(env.GRAM_QUOTE_MINUTES || 10);
  const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
  return { invoiceCode, nanotons, rateAedPerGram, gramAmount, expiresAt };
}

function buildSendTransactionRequest({ merchantAddress, nanotons, invoiceCode, validUntilUnix }) {
  return {
    valid_until: validUntilUnix,
    messages: [{ address: merchantAddress, amount: nanotons, payload: commentPayloadBase64(invoiceCode) }],
  };
}

function widgetHtml({ code, gramAmountStr, aedStr, expiresAtMs }) {
  return `<!doctype html><meta charset=utf-8>
<style>
body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:12px;color:var(--tg-theme-text-color,#000)}
.amt{font-size:20px;font-weight:700}
.sub{color:var(--tg-theme-hint-color,#888);font-size:12px;margin:2px 0 10px}
button{width:100%;padding:10px;border:0;border-radius:10px;font:700 14px inherit;background:var(--tg-theme-button-color,#3390ec);color:var(--tg-theme-button-text-color,#fff)}
button:disabled{opacity:.5}
#msg{margin-top:8px;font-size:12px;color:var(--tg-theme-hint-color,#888)}
</style>
<div class="amt">${esc(gramAmountStr)} GRAM</div>
<div class="sub">&#8776; ${esc(aedStr)} AED</div>
<button id=b>Pay with Wallet</button>
<div id=msg></div>
<script>
var CODE=${JSON.stringify(code)}, EXP=${expiresAtMs};
var b=document.getElementById('b'), msg=document.getElementById('msg');
function tick(){
  var left=EXP-Date.now();
  if(left<=0){ b.disabled=true; b.textContent='Quote expired'; msg.textContent='Reopen the shop for a new price.'; return; }
  var m=Math.floor(left/60000), s=Math.floor((left%60000)/1000);
  b.textContent='Pay with Wallet ('+m+':'+String(s).padStart(2,'0')+')';
}
tick(); setInterval(tick,1000);
if(!TelegramWidget.wallet){ b.disabled=true; b.textContent='No wallet available'; msg.textContent='Open this chat in a Telegram app version with a wallet.'; }
b.onclick=function(){
  if(b.disabled) return;
  b.disabled=true; msg.textContent='Waiting for wallet\\u2026';
  TelegramWidget.request('pay:'+CODE,{wallet:true}).then(function(a){
    var res=JSON.parse(a.result);
    if(!res.messages){ msg.textContent=res.error||'Could not start payment.'; b.disabled=false; tick(); return; }
    return TelegramWidget.wallet.sendTransaction(res,'paid:'+CODE).then(function(){
      msg.textContent='Payment sent \\u2014 confirming on-chain, this can take a minute.';
    });
  }).catch(function(e){
    msg.textContent = e==='REJECTED' ? 'Cancelled in wallet.' : e==='BAD_REQUEST' ? 'Wallet refused the transaction.' : 'Something went wrong, try again.';
    b.disabled=false; tick();
  });
};
</script>`;
}

export function buildPayWidgetMessage(order) {
  const gramAmount = Number(order.gram_amount_nanotons) / 1e9;
  const gramAmountStr = gramAmount.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const html = widgetHtml({
    code: order.gram_invoice_code,
    gramAmountStr,
    aedStr: (order.total / 100).toFixed(2),
    expiresAtMs: new Date(order.quote_expires_at).getTime(),
  });
  return { chat_id: order.user_id, html, allow_queries: true, caption: `Order #${order.id} — pay with GRAM` };
}

// Handles the `widget_query` update from the Pay widget. Never marks an
// order paid here — only pollGramPayments() does that, against the chain.
export async function handleWidgetQuery(env, wq) {
  const answer = (data) => tg(env, 'answerWidgetQuery', { widget_query_id: wq.id, data: JSON.stringify(data) });
  const [, code] = String(wq.data || '').split(':');
  if (!code) return answer({ error: 'Bad request' });

  const order = await env.DB.prepare("SELECT * FROM orders WHERE gram_invoice_code = ? AND payment_method = 'gram'").bind(code).first();
  if (!order) return answer({ error: 'Order not found' });

  if (wq.type?.type === 'sent_transaction') {
    await env.DB.prepare('UPDATE orders SET gram_claimed_msg_hash = ? WHERE id = ?').bind(wq.type.msg_hash || null, order.id).run();
    return answer({ ok: true }); // acknowledged only — payment is confirmed solely by pollGramPayments()
  }

  const expiresAtMs = new Date(order.quote_expires_at).getTime();
  const expired = expiresAtMs < Date.now();
  if (expired && order.payment_status === 'awaiting') {
    await env.DB.prepare("UPDATE orders SET payment_status = 'expired' WHERE id = ?").bind(order.id).run();
  }
  if (order.payment_status !== 'awaiting' || expired) {
    const already = order.payment_status === 'paid' || order.payment_status === 'overpaid';
    return answer({ error: already ? 'Already paid' : 'Quote expired — reopen the shop for a new price' });
  }

  return answer(buildSendTransactionRequest({
    merchantAddress: env.GRAM_MERCHANT_ADDRESS,
    nanotons: order.gram_amount_nanotons,
    invoiceCode: order.gram_invoice_code,
    validUntilUnix: Math.floor(expiresAtMs / 1000),
  }));
}

function formatNanotons(n) {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').slice(0, 4);
  return `${whole}.${frac}`;
}

async function markOrder(env, id, paymentStatus, fields) {
  const sets = ['payment_status = ?'];
  const vals = [paymentStatus];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  vals.push(id);
  await env.DB.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

async function processIncomingTransaction(env, txn) {
  const msg = txn.in_msg;
  const comment = (msg?.message || '').trim();
  if (!comment) return; // not a text-comment transfer — nothing to match on

  const order = await env.DB.prepare("SELECT * FROM orders WHERE gram_invoice_code = ? AND payment_method = 'gram'").bind(comment).first();
  const gotNanotons = BigInt(msg.value || '0');
  const txHash = txn.transaction_id.hash;
  const sender = msg.source || 'unknown';

  if (!order) {
    await tg(env, 'sendMessage', {
      chat_id: env.ADMIN_ID,
      text: `⚠️ Unmatched GRAM payment: ${formatNanotons(gotNanotons)} GRAM from ${sender}, comment "${esc(comment)}" doesn't match any order. tx ${txHash}`,
    });
    return;
  }

  if (order.payment_status === 'paid' || order.payment_status === 'overpaid') {
    await tg(env, 'sendMessage', {
      chat_id: env.ADMIN_ID,
      text: `⚠️ Duplicate GRAM payment for order #${order.id} (already ${order.payment_status}). New tx ${txHash}, ${formatNanotons(gotNanotons)} GRAM from ${sender} — needs manual refund.`,
    });
    return;
  }

  if (order.payment_status !== 'awaiting') {
    await tg(env, 'sendMessage', {
      chat_id: env.ADMIN_ID,
      text: `⚠️ GRAM payment for order #${order.id} arrived while its status is already "${order.payment_status}". New tx ${txHash}, ${formatNanotons(gotNanotons)} GRAM — review manually.`,
    });
    return;
  }

  const expected = BigInt(order.gram_amount_nanotons);
  const expiresAtMs = new Date(order.quote_expires_at).getTime();
  const late = txn.utime * 1000 > expiresAtMs;

  if (late) {
    await markOrder(env, order.id, 'late', { paid_amount_nanotons: gotNanotons.toString(), tx_hash: txHash });
    await tg(env, 'sendMessage', {
      chat_id: env.ADMIN_ID,
      text: `⏰ Late GRAM payment for order #${order.id}: ${formatNanotons(gotNanotons)} GRAM arrived after its quote expired. tx ${txHash}. Decide whether to honor the old rate or refund.`,
    });
    return;
  }

  if (gotNanotons < expected) {
    await markOrder(env, order.id, 'underpaid', { paid_amount_nanotons: gotNanotons.toString(), tx_hash: txHash });
    await tg(env, 'sendMessage', {
      chat_id: env.ADMIN_ID,
      text: `⚠️ Underpaid GRAM order #${order.id}: expected ${formatNanotons(expected)} GRAM, got ${formatNanotons(gotNanotons)}. tx ${txHash}. Ask the customer to top up, or cancel & refund.`,
    });
    return;
  }

  const overpaid = gotNanotons > expected;
  await markOrder(env, order.id, overpaid ? 'overpaid' : 'paid', {
    paid_amount_nanotons: gotNanotons.toString(), tx_hash: txHash, paid_at: new Date().toISOString(),
  });

  const fresh = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(order.id).first();
  await notifyAdmin(env, fresh, null); // same "new order" message the COD flow sends immediately, just deferred until actually paid
  if (fresh.user_id) {
    await tg(env, 'sendMessage', { chat_id: fresh.user_id, text: `✅ Payment received for order #${fresh.id}. We'll get it ready for delivery!` });
  }
  if (fresh.agent_code) {
    const agent = await getAgent(env, fresh.agent_code);
    if (agent) {
      await tg(env, 'sendMessage', {
        chat_id: agent.user_id,
        text: `🛒 New order #${fresh.id} from your customer — ${aed(fresh.total)} (paid with GRAM).\nYour commission ${aed(fresh.commission)} will be credited after delivery.`,
      });
    }
  }
  if (overpaid) {
    await tg(env, 'sendMessage', {
      chat_id: env.ADMIN_ID,
      text: `💸 Order #${fresh.id} was overpaid by ${formatNanotons(gotNanotons - expected)} GRAM — refund the difference to ${sender}. tx ${txHash}`,
    });
  }
}

// Run on a schedule (see the cron trigger in wrangler.toml). Polls the
// merchant wallet for new incoming transactions since the last check and
// matches them to orders by on-chain comment + amount — the only thing that
// actually marks a GRAM order paid.
export async function pollGramPayments(env) {
  const headers = env.TONCENTER_API_KEY ? { 'X-API-Key': env.TONCENTER_API_KEY } : {};
  const state = await env.DB.prepare('SELECT * FROM gram_poll_state WHERE id = 1').first();

  const url = new URL(env.TONCENTER_BASE_URL + '/getTransactions');
  url.searchParams.set('address', env.GRAM_MERCHANT_ADDRESS);
  url.searchParams.set('limit', '50');
  if (state?.last_lt) url.searchParams.set('to_lt', state.last_lt);

  const r = await fetch(url, { headers });
  if (!r.ok) { console.error('gram poll: toncenter http', r.status); return; }
  const j = await r.json();
  if (!j.ok) { console.error('gram poll: toncenter error', j.error); return; }
  const txs = j.result || []; // newest first
  if (!txs.length) return;

  if (!state?.last_lt) {
    // First run ever — remember the current tip, don't process pre-existing history.
    await env.DB.prepare('UPDATE gram_poll_state SET last_lt = ?, last_hash = ? WHERE id = 1')
      .bind(txs[0].transaction_id.lt, txs[0].transaction_id.hash).run();
    return;
  }

  if (txs.length === 50 && BigInt(txs[txs.length - 1].transaction_id.lt) > BigInt(state.last_lt)) {
    console.error('gram poll: more than 50 new transactions since last check — catching up over the next few runs');
  }

  for (const txn of [...txs].reverse()) { // oldest first, so the cursor advances in order
    if (BigInt(txn.transaction_id.lt) <= BigInt(state.last_lt)) continue;
    await processIncomingTransaction(env, txn);
    await env.DB.prepare('UPDATE gram_poll_state SET last_lt = ?, last_hash = ? WHERE id = 1')
      .bind(txn.transaction_id.lt, txn.transaction_id.hash).run();
  }
}
