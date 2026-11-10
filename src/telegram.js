// Thin wrapper over the Telegram Bot API, shared by index.js and gram.js.
export async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) console.error('tg', method, j.description);
    return j;
  } catch (e) {
    console.error('tg', method, e.message); // a failed notification must never break an order
    return { ok: false };
  }
}
