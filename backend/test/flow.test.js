import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

process.env.DOC_REVIEW_MS = '0';
process.env.OFFER_DELAY_MS = '0';

async function boot() {
  const db = openDb(':memory:');
  let t = new Date('2026-10-22T10:00:00+05:30').getTime();
  const app = createApp(db, { now: () => t });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { call, advance: ms => (t += ms), close: () => server.close(), db };
}

async function signIn(api, phone = '9876543210') {
  const s = await api.call('POST', '/api/auth/send-otp', { phone });
  assert.equal(s.status, 200);
  const v = await api.call('POST', '/api/auth/verify-otp', { phone, otp: s.body.demoOtp });
  assert.equal(v.status, 200);
  return v.body.token;
}
async function activate(api, token) {
  for (const d of ['id', 'dl', 'rc', 'selfie', 'bank']) assert.equal((await api.call('POST', `/api/documents/${d}`, { fileName: d + '.jpg' }, token)).status, 201);
  const sub = await api.call('POST', '/api/profile/submit', {}, token);
  assert.equal(sub.status, 200);
  assert.equal(sub.body.rider.status, 'active');
}

test('login: validation, wrong codes, lockout, session', async () => {
  const api = await boot();
  try {
    assert.equal((await api.call('POST', '/api/auth/send-otp', { phone: '12345' })).body.code, 'invalid_phone');
    const s = await api.call('POST', '/api/auth/send-otp', { phone: '9876543210' });
    const wrong = s.body.demoOtp === '0000' ? '1111' : '0000';
    for (let i = 0; i < 5; i++) assert.equal((await api.call('POST', '/api/auth/verify-otp', { phone: '9876543210', otp: wrong })).body.code, 'otp_invalid');
    const locked = await api.call('POST', '/api/auth/verify-otp', { phone: '9876543210', otp: s.body.demoOtp });
    assert.equal(locked.status, 429);
    assert.equal((await api.call('POST', '/api/auth/send-otp', { phone: '9876543210' })).status, 429); // resend rate limit
    api.advance(31_000);
    const token = await signIn(api);
    assert.equal((await api.call('GET', '/api/me', null, token)).status, 200);
    assert.equal((await api.call('GET', '/api/me')).status, 401);
    await api.call('POST', '/api/auth/logout', {}, token);
    assert.equal((await api.call('GET', '/api/me', null, token)).status, 401);
  } finally { api.close(); }
});

test('profile gate: cannot go online before documents are verified', async () => {
  const api = await boot();
  try {
    const token = await signIn(api);
    assert.equal((await api.call('POST', '/api/status', { online: true }, token)).body.code, 'profile_incomplete');
    assert.equal((await api.call('POST', '/api/profile/submit', {}, token)).body.code, 'documents_incomplete');
  } finally { api.close(); }
});

test('full delivery flow: online → offer → accept → pickup → deliver → settle → shift end', async () => {
  const api = await boot();
  try {
    const token = await signIn(api);
    await activate(api, token);

    const dash0 = (await api.call('GET', '/api/dashboard', null, token)).body;
    assert.equal(dash0.today.deliveries, 0);

    // offline riders get no offers
    assert.equal((await api.call('GET', '/api/orders/offer', null, token)).body.offer, null);
    assert.equal((await api.call('POST', '/api/status', { online: true }, token)).body.rider.online, true);

    const { offer } = (await api.call('GET', '/api/orders/offer', null, token)).body;
    assert.ok(offer, 'an offer is dispatched');
    assert.equal(offer.status, 'offered');
    assert.equal(offer.customer.address, null, 'full address hidden before pickup');
    const id = offer.id;

    // state machine: cannot skip steps
    assert.equal((await api.call('POST', `/api/orders/${id}/pickup`, {}, token)).body.code, 'invalid_state');
    assert.equal((await api.call('POST', `/api/orders/${id}/accept`, {}, token)).status, 200);
    assert.equal((await api.call('POST', `/api/orders/${id}/accept`, {}, token)).body.code, 'invalid_state');
    assert.equal((await api.call('POST', '/api/status', { online: false }, token)).body.code, 'order_in_progress');

    assert.equal((await api.call('POST', `/api/orders/${id}/arrive`, {}, token)).status, 200);
    const wrong = offer.demo.pickupCode === '0000' ? '1111' : '0000';
    assert.equal((await api.call('POST', `/api/orders/${id}/verify-pickup`, { code: wrong }, token)).body.code, 'code_mismatch');
    assert.equal((await api.call('POST', `/api/orders/${id}/verify-pickup`, { code: offer.demo.pickupCode }, token)).status, 200);
    api.advance(2 * 60_000);
    const picked = await api.call('POST', `/api/orders/${id}/pickup`, { checked: [0, 1, 2, 3] }, token);
    assert.equal(picked.body.order.customer.address.length > 5, true, 'address revealed after pickup');
    assert.equal((await api.call('POST', `/api/orders/${id}/contact`, { message: 'I am 5 minutes away' }, token)).status, 201);
    assert.equal((await api.call('POST', `/api/orders/${id}/contact`, { message: '  ' }, token)).body.code, 'empty_message');
    assert.equal((await api.call('POST', `/api/orders/${id}/reached`, {}, token)).status, 200);

    const wrongOtp = offer.demo.deliveryOtp === '0000' ? '1111' : '0000';
    assert.equal((await api.call('POST', `/api/orders/${id}/deliver`, { otp: wrongOtp }, token)).body.code, 'code_mismatch');
    assert.equal((await api.call('POST', `/api/orders/${id}/deliver`, { otp: offer.demo.deliveryOtp }, token)).status, 200);

    // cash orders cannot settle without collecting cash
    if (offer.paymentType === 'cod') {
      assert.equal((await api.call('POST', `/api/orders/${id}/settle`, { cashCollected: false }, token)).body.code, 'cash_not_collected');
    }
    const settled = await api.call('POST', `/api/orders/${id}/settle`, { cashCollected: true }, token);
    assert.equal(settled.status, 200);
    const sum = settled.body.earnings.lines.reduce((a, l) => a + l.amount, 0);
    assert.equal(sum, settled.body.earnings.total);
    assert.ok(settled.body.earnings.total > 0);
    assert.equal(settled.body.today.deliveries, 1);
    assert.equal(settled.body.today.earnings, sum);
    assert.equal(settled.body.rider.cashInHand, offer.paymentType === 'cod' ? offer.orderValue : 0);
    assert.equal((await api.call('POST', `/api/orders/${id}/settle`, { cashCollected: true }, token)).body.code, 'invalid_state', 'no double settlement');

    const earn = (await api.call('GET', '/api/earnings?range=today', null, token)).body;
    assert.equal(earn.deliveries, 1);
    assert.equal(earn.earnings, sum);
    assert.equal(earn.orders.length, 1);

    const end = await api.call('POST', '/api/shift/end', {}, token);
    assert.equal(end.status, 200);
    assert.equal(end.body.summary.deliveries, 1);
    assert.equal(end.body.summary.earnings, sum);
    assert.equal(end.body.rider.online, false);
  } finally { api.close(); }
});

test('offers expire after 30 seconds and can be declined', async () => {
  const api = await boot();
  try {
    const token = await signIn(api);
    await activate(api, token);
    await api.call('POST', '/api/status', { online: true }, token);
    const a = (await api.call('GET', '/api/orders/offer', null, token)).body.offer;
    api.advance(31_000);
    assert.equal((await api.call('POST', `/api/orders/${a.id}/accept`, {}, token)).body.code, 'offer_expired');
    const b = (await api.call('GET', '/api/orders/offer', null, token)).body.offer;
    assert.notEqual(b.id, a.id, 'a fresh offer replaces the expired one');
    assert.equal((await api.call('POST', `/api/orders/${b.id}/decline`, {}, token)).status, 200);
  } finally { api.close(); }
});

test('riders cannot touch each other\'s orders', async () => {
  const api = await boot();
  try {
    const t1 = await signIn(api, '9876543210');
    api.advance(31_000);
    const t2 = await signIn(api, '9123456780');
    await activate(api, t1); await activate(api, t2);
    await api.call('POST', '/api/status', { online: true }, t1);
    const o = (await api.call('GET', '/api/orders/offer', null, t1)).body.offer;
    assert.equal((await api.call('POST', `/api/orders/${o.id}/accept`, {}, t2)).status, 404);
  } finally { api.close(); }
});
