// The order card: one Telegram widget per order in the customer's chat.
// It shows the items, a status tracker (Placed -> Confirmed -> Delivered), the
// payment (GRAM via Telegram's wallet, or cash) and, once the order is done,
// "Order again". The HTML is fixed and generic: everything about the order is
// in the widget's chat_data, so a reorder turns the same card into the new
// order with editMessageWidgetData instead of sending a new widget.
//
// As everywhere: the widget's notices are never proof of payment. Only the
// on-chain poller in gram.js marks an order paid.
import cardHtml from './card.html';
import { tg } from './telegram.js';
import {
  widgetState, buildPayTransaction, claimSentTransaction, requote, switchToCod, getOrder, isPayable,
} from './gram.js';
import { reorderFrom } from './index.js';

const STATE_LIMIT = 900; // chat_data and answers are capped at 1024 bytes; leave room for {"st":…}

export function cardState(o) {
  const p = o.payment_status === 'refunded' ? { s: 'refunded' } : widgetState(o);
  const items = JSON.parse(o.items).map((i) => [i.name, i.qty, i.price]);
  const state = { o: o.id, it: items, t: o.total, a: String(o.address || '').slice(0, 80), st: o.status, p };
  let json = JSON.stringify(state);
  // Big carts: shorten the address, then the item names, until it fits.
  for (let n = 60; new TextEncoder().encode(json).length > STATE_LIMIT && n >= 8; n -= 8) {
    state.a = state.a.slice(0, n);
    state.it = items.map(([name, q, pr]) => [name.slice(0, n), q, pr]);
    json = JSON.stringify(state);
  }
  return state;
}

// Sends a new card. Returns false if Telegram refused it.
export async function sendCard(env, o) {
  if (!o.user_id) return false;
  const w = await tg(env, 'sendWidget', {
    chat_id: o.user_id, html: cardHtml, chat_data: JSON.stringify(cardState(o)), allow_queries: true,
  });
  if (!w.ok) return false;
  await env.DB.prepare('UPDATE orders SET card_message_id = ? WHERE id = ?').bind(w.result.message_id, o.id).run();
  return true;
}

// Turns an existing card (the one "Order again" was tapped on) into order `o`.
export async function moveCard(env, o, messageId) {
  const r = await tg(env, 'editMessageWidgetData', { chat_id: o.user_id, message_id: messageId, chat_data: JSON.stringify(cardState(o)) });
  if (!r.ok) return false;
  await env.DB.prepare('UPDATE orders SET card_message_id = NULL WHERE user_id = ? AND card_message_id = ?').bind(o.user_id, messageId).run();
  await env.DB.prepare('UPDATE orders SET card_message_id = ? WHERE id = ?').bind(messageId, o.id).run();
  return true;
}

export async function pushCard(env, o) {
  if (!o.user_id || !o.card_message_id) return;
  await tg(env, 'editMessageWidgetData', { chat_id: o.user_id, message_id: o.card_message_id, chat_data: JSON.stringify(cardState(o)) });
}

// Requests from a card: "<action>:<order id>[:<arg>]".
export async function handleCardQuery(env, wq, action, id, arg) {
  const answer = (data) => tg(env, 'answerWidgetQuery', { widget_query_id: wq.id, data: JSON.stringify(data) });
  let o = await getOrder(env, id);
  // `from` is authenticated by Telegram; only the customer who placed the order may act on it.
  if (!o || o.user_id !== wq.from?.id) return answer({ err: 'Order not found.' });
  const reply = async (err) => {
    o = await getOrder(env, o.id);
    await pushCard(env, o);
    return answer({ st: cardState(o), ...(err ? { err } : {}) });
  };
  const open = isPayable(o);

  if (wq.type?.type === 'sent_transaction') {
    if (open) await claimSentTransaction(env, o, wq.type.msg_hash);
    return reply();
  }

  switch (action) {
    case 'pay': {
      if (!open) return reply();
      const tx = await buildPayTransaction(env, o);
      return tx.error ? reply(tx.error) : answer(tx);
    }
    case 'new':
      if (open) {
        try { await requote(env, o); } catch (e) {
          console.error('gram requote failed', e.message);
          return reply('Could not get a live price right now. Try again in a moment.');
        }
      }
      return reply();
    case 'cod':
      if (open) await switchToCod(env, o, wq.from);
      return reply();
    case 'again': {
      if (o.status !== 'delivered' && o.status !== 'cancelled') return reply();
      const r = await reorderFrom(env, o, arg === 'g' ? 'gram' : 'cod', wq.message_id, wq.from);
      if (r.error) return reply(r.error);
      return answer({ st: cardState(await getOrder(env, r.order.id)) });
    }
    default:
      return reply(); // 'st': report the current state
  }
}
