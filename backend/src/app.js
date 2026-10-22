import express from 'express';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const DEMO = process.env.DEMO_MODE !== '0'; // demo mode returns OTPs and codes in responses
const OTP_TTL = 5 * 60_000, SESSION_TTL = 30 * 24 * 3600_000, OFFER_TTL = 30_000;
const DOC_TYPES = ['id', 'dl', 'rc', 'selfie', 'bank'];
const GOAL = 600, BONUS_TARGET = 10, BONUS = 150;

const RESTAURANTS = [
  ['Spice Route Kitchen', 'Shop 12, MG Road Market'], ['Tandoor Tales', '14, Central Mall Food Court'],
  ['Dosa Junction', 'Sector 18 Market'], ['Biryani Bay', '22, Link Road'],
];
const CUSTOMERS = [
  ['Aarav S.', 'Palm Residency', 'Tower B, Flat 904, Palm Residency'], ['Meera K.', 'Lotus Heights', 'A-402, Lotus Heights'],
  ['Kabir R.', 'Green Park Apartments', 'Block C, Flat 118, Green Park Apartments'],
];
const MENU = [['Paneer Butter Masala', 220], ['Butter Naan', 35], ['Jeera Rice', 140], ['Masala Dosa', 120], ['Chicken Biryani', 280], ['Raita', 50]];

const sha = s => createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const code4 = () => String(randomInt(0, 10000)).padStart(4, '0');
const ymd = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const bad = (m, c) => new HttpError(400, m, c), conflict = (m, c) => new HttpError(409, m, c);

export function createApp(db, { now = () => Date.now() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  /* ---------- helpers ---------- */
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const wrap = fn => (req, res, next) => { try { Promise.resolve(fn(req, res)).catch(next); } catch (e) { next(e); } };

  function requireAuth(req, res, next) {
    const h = req.get('Authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const s = token && one('SELECT rider_id, expires_at FROM sessions WHERE token_hash = ?', sha(token));
    if (!s || s.expires_at < now()) return next(new HttpError(401, 'Please sign in again.', 'unauthorized'));
    req.rider = one('SELECT * FROM riders WHERE id = ?', s.rider_id);
    req.tokenHash = sha(token);
    next();
  }
  const requireActive = (req, res, next) =>
    req.rider.status === 'active' ? next() : next(new HttpError(403, 'Finish profile verification first.', 'profile_incomplete'));

  const riderView = r => ({ id: r.id, riderId: r.rider_code, name: r.name, phone: r.phone, vehicle: r.vehicle, status: r.status, online: !!r.online, cashInHand: r.cash_in_hand });
  const orderView = (o, withSecrets = true) => {
    const picked = ['picked_up', 'at_customer', 'delivered', 'settled'].includes(o.status);
    const v = {
      id: o.public_id, status: o.status, restaurant: o.restaurant, restaurantAddress: o.rest_address,
      customer: { name: o.customer_name, area: o.customer_area, phone: maskPhone(o.customer_phone), address: picked ? o.customer_addr : null },
      deliveryNote: picked ? o.delivery_note : null, items: JSON.parse(o.items_json),
      orderValue: o.order_value, paymentType: o.payment_type,
      toRestaurant: { km: o.km_to_rest, min: o.min_to_rest }, toCustomer: { km: o.km_to_cust, min: o.min_to_cust },
      payout: estimate(o).total, expiresAt: o.expires_at, offeredAt: o.offered_at,
    };
    if (DEMO && withSecrets) v.demo = { pickupCode: o.pickup_code, deliveryOtp: o.drop_otp };
    return v;
  };
  const maskPhone = p => p.slice(0, 3) + ' ' + p.slice(3, 5) + '•••• ' + p.slice(-4);

  function earnLines(o, t) {
    const hr = new Date(t).getHours();
    const lines = [['Base fare', 30], [`Distance (${o.km_to_cust} km)`, Math.round(o.km_to_cust * 10)]];
    if ((hr >= 12 && hr < 15) || (hr >= 19 && hr < 23)) lines.push(['Peak-hour incentive', 12]);
    if (o.tip) lines.push(['Customer tip', o.tip]);
    if (o.arrived_rest_at && o.picked_up_at && o.picked_up_at - o.arrived_rest_at > 10 * 60_000) lines.push(['Late pickup adjustment', -4]);
    return lines;
  }
  function estimate(o) { const l = earnLines({ ...o, tip: 0 }, o.offered_at); return { lines: l, total: l.reduce((a, b) => a + b[1], 0) }; }

  function activeOrder(riderId) {
    return one(`SELECT * FROM orders WHERE rider_id = ? AND status IN
      ('accepted','at_restaurant','verified','picked_up','at_customer','delivered') ORDER BY id DESC LIMIT 1`, riderId);
  }
  function expireOffers(riderId) {
    run(`UPDATE orders SET status = 'expired' WHERE rider_id = ? AND status = 'offered' AND expires_at < ?`, riderId, now());
  }
  function stats(riderId, since) {
    const e = one('SELECT COALESCE(SUM(amount),0) AS total FROM earning_lines WHERE rider_id = ? AND created_at >= ?', riderId, since);
    const d = one(`SELECT COUNT(*) AS n FROM orders WHERE rider_id = ? AND status = 'settled' AND settled_at >= ?`, riderId, since);
    return { earnings: e.total, deliveries: d.n };
  }
  function rates(riderId) {
    const o = one(`SELECT COUNT(*) AS offered, SUM(status NOT IN ('declined','expired','offered')) AS taken FROM orders WHERE rider_id = ?`, riderId);
    const acceptance = o.offered ? Math.round(100 * (o.taken || 0) / o.offered) : 100;
    return { acceptance, onTime: 96, rating: 4.8 };
  }
  const onlineMinutes = r => r.online && r.online_since ? Math.floor((now() - r.online_since) / 60_000) : 0;

  /* ---------- health ---------- */
  app.get('/api/health', (req, res) => res.json({ ok: true, demo: DEMO, time: now() }));

  /* ---------- auth ---------- */
  app.post('/api/auth/send-otp', wrap((req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone)) throw bad('Enter a valid 10-digit mobile number.', 'invalid_phone');
    const prev = one('SELECT sent_at FROM otps WHERE phone = ?', phone);
    if (prev && now() - prev.sent_at < 30_000) throw new HttpError(429, 'Wait 30 seconds before asking for another code.', 'otp_rate_limited');
    const code = code4();
    run(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_at) VALUES (?,?,?,0,?)
         ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at`,
      phone, sha(phone + ':' + code), now() + OTP_TTL, now());
    // Production: hand `code` to an SMS provider here. It is never logged or returned outside demo mode.
    res.json({ sent: true, expiresInSec: OTP_TTL / 1000, ...(DEMO ? { demoOtp: code } : {}) });
  }));

  app.post('/api/auth/verify-otp', wrap((req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '').slice(-10);
    const code = String(req.body?.otp || '');
    const rec = one('SELECT * FROM otps WHERE phone = ?', phone);
    if (!rec || rec.expires_at < now()) throw bad('That code has expired. Ask for a new one.', 'otp_expired');
    if (rec.attempts >= 5) throw new HttpError(429, 'Too many wrong attempts. Ask for a new code.', 'otp_locked');
    if (!safeEq(sha(phone + ':' + code), rec.code_hash)) {
      run('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?', phone);
      throw bad('That code is not right. Check the SMS and try again.', 'otp_invalid');
    }
    run('DELETE FROM otps WHERE phone = ?', phone);
    let rider = one('SELECT * FROM riders WHERE phone = ?', phone), isNew = false;
    if (!rider) {
      isNew = true;
      const r = run('INSERT INTO riders (phone, rider_code, created_at) VALUES (?,?,?)', phone, 'RG-' + randomInt(10000, 99999), now());
      rider = one('SELECT * FROM riders WHERE id = ?', r.lastInsertRowid);
    }
    const token = randomBytes(32).toString('hex');
    run('INSERT INTO sessions (token_hash, rider_id, expires_at, created_at) VALUES (?,?,?,?)', sha(token), rider.id, now() + SESSION_TTL, now());
    res.json({ token, isNew, rider: riderView(rider) });
  }));

  app.post('/api/auth/logout', requireAuth, wrap((req, res) => { run('DELETE FROM sessions WHERE token_hash = ?', req.tokenHash); res.json({ ok: true }); }));

  /* ---------- profile + documents ---------- */
  app.get('/api/me', requireAuth, wrap((req, res) => res.json({ rider: riderView(req.rider) })));

  app.put('/api/me', requireAuth, wrap((req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const vehicle = ['Motorbike', 'Scooter', 'Bicycle'].includes(req.body?.vehicle) ? req.body.vehicle : req.rider.vehicle;
    if (name.length < 2) throw bad('Enter your full name.', 'invalid_name');
    run('UPDATE riders SET name = ?, vehicle = ? WHERE id = ?', name, vehicle, req.rider.id);
    res.json({ rider: riderView(one('SELECT * FROM riders WHERE id = ?', req.rider.id)) });
  }));

  const docsOf = id => {
    // Demo review: a document counts as verified a few seconds after upload. Production would review manually.
    const wait = Number(process.env.DOC_REVIEW_MS ?? 1500);
    run(`UPDATE documents SET status='verified', verified_at=? WHERE rider_id=? AND status='pending' AND uploaded_at <= ?`, now(), id, now() - wait);
    const rows = all('SELECT type, status, file_name, uploaded_at FROM documents WHERE rider_id = ?', id);
    return DOC_TYPES.map(t => rows.find(r => r.type === t) || { type: t, status: 'missing' });
  };
  app.get('/api/documents', requireAuth, wrap((req, res) => {
    const documents = docsOf(req.rider.id);
    res.json({ documents, verified: documents.filter(d => d.status === 'verified').length, total: DOC_TYPES.length });
  }));
  app.post('/api/documents/:type', requireAuth, wrap((req, res) => {
    const { type } = req.params;
    if (!DOC_TYPES.includes(type)) throw bad('Unknown document type.', 'invalid_type');
    const fileName = String(req.body?.fileName || `${type}.jpg`).slice(0, 120);
    run(`INSERT INTO documents (rider_id, type, status, file_name, uploaded_at) VALUES (?,?,'pending',?,?)
         ON CONFLICT(rider_id, type) DO UPDATE SET status='pending', file_name=excluded.file_name, uploaded_at=excluded.uploaded_at, verified_at=NULL`,
      req.rider.id, type, fileName, now());
    res.status(201).json({ type, status: 'pending' });
  }));
  app.post('/api/profile/submit', requireAuth, wrap((req, res) => {
    const docs = docsOf(req.rider.id);
    if (docs.some(d => d.status !== 'verified')) throw conflict('All 5 documents must be verified first.', 'documents_incomplete');
    if (!req.rider.name) run(`UPDATE riders SET name = 'Rohit Verma' WHERE id = ?`, req.rider.id);
    run(`UPDATE riders SET status = 'active' WHERE id = ?`, req.rider.id);
    res.json({ rider: riderView(one('SELECT * FROM riders WHERE id = ?', req.rider.id)) });
  }));

  /* ---------- dashboard + online ---------- */
  app.get('/api/dashboard', requireAuth, wrap((req, res) => {
    const r = req.rider, today0 = ymd(now());
    const today = stats(r.id, today0);
    const week = [];
    const dow = (new Date(now()).getDay() + 6) % 7;
    for (let i = 0; i < 7; i++) {
      const s = today0 - (dow - i) * 86400_000;
      week.push(i > dow ? null : one('SELECT COALESCE(SUM(amount),0) AS v FROM earning_lines WHERE rider_id = ? AND created_at >= ? AND created_at < ?', r.id, s, s + 86400_000).v);
    }
    res.json({
      rider: riderView(r), today: { ...today, onlineMinutes: onlineMinutes(r) },
      goal: GOAL, week, todayIndex: dow,
      bonus: { target: BONUS_TARGET, amount: BONUS, progress: Math.min(today.deliveries, BONUS_TARGET) },
      rates: rates(r.id), activeOrder: (() => { const o = activeOrder(r.id); return o ? orderView(o) : null; })(),
    });
  }));

  app.post('/api/status', requireAuth, requireActive, wrap((req, res) => {
    const online = !!req.body?.online;
    if (!online && activeOrder(req.rider.id)) throw conflict('Finish your current delivery before going offline.', 'order_in_progress');
    tx(() => {
      if (online && !req.rider.online) {
        run('UPDATE riders SET online = 1, online_since = ? WHERE id = ?', now(), req.rider.id);
        if (!one('SELECT id FROM shifts WHERE rider_id = ? AND ended_at IS NULL', req.rider.id))
          run('INSERT INTO shifts (rider_id, started_at) VALUES (?,?)', req.rider.id, now());
      } else if (!online && req.rider.online) {
        run('UPDATE riders SET online = 0 WHERE id = ?', req.rider.id);
        run(`UPDATE orders SET status='expired' WHERE rider_id = ? AND status = 'offered'`, req.rider.id);
      }
    });
    res.json({ rider: riderView(one('SELECT * FROM riders WHERE id = ?', req.rider.id)) });
  }));

  /* ---------- orders ---------- */
  function ownOrder(req, ...allowed) {
    const o = one('SELECT * FROM orders WHERE public_id = ? AND rider_id = ?', req.params.id, req.rider.id);
    if (!o) throw new HttpError(404, 'Order not found.', 'not_found');
    if (allowed.length && !allowed.includes(o.status))
      throw conflict(`This step is not available while the order is "${o.status.replace('_', ' ')}".`, 'invalid_state');
    return o;
  }

  // Polled by the app while the rider is online. Hands out one offer at a time.
  app.get('/api/orders/offer', requireAuth, requireActive, wrap((req, res) => {
    const r = req.rider;
    expireOffers(r.id);
    const live = activeOrder(r.id);
    if (live) return res.json({ offer: null, activeOrder: orderView(live) });
    if (!r.online) return res.json({ offer: null });
    let offer = one(`SELECT * FROM orders WHERE rider_id = ? AND status = 'offered' ORDER BY id DESC LIMIT 1`, r.id);
    const wait = Number(process.env.OFFER_DELAY_MS ?? 2500);
    if (!offer) {
      const last = one('SELECT MAX(offered_at) AS t FROM orders WHERE rider_id = ?', r.id).t || 0;
      if (now() - Math.max(last, r.online_since || 0) < wait) return res.json({ offer: null });
      const [rest, raddr] = RESTAURANTS[randomInt(RESTAURANTS.length)], [cn, ca, cad] = CUSTOMERS[randomInt(CUSTOMERS.length)];
      const items = [...MENU].sort(() => Math.random() - .5).slice(0, 3).map(([n, p]) => ({ name: n, qty: n.includes('Naan') ? 4 : 1, price: p }));
      const value = items.reduce((a, i) => a + i.qty * i.price, 0), cod = randomInt(2) === 0;
      const kmR = +(0.6 + Math.random() * 1.8).toFixed(1), kmC = +(1.2 + Math.random() * 3).toFixed(1);
      const id = run(`INSERT INTO orders (public_id, rider_id, status, restaurant, rest_address, customer_name, customer_area, customer_addr, customer_phone,
          delivery_note, items_json, order_value, payment_type, km_to_rest, km_to_cust, min_to_rest, min_to_cust, pickup_code, drop_otp, offered_at, expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        'RG-' + randomInt(10000, 99999), r.id, 'offered', rest, raddr, cn, ca, cad, '+9198' + randomInt(10000000, 99999999),
        'Please ring the bell once. Do not knock.', JSON.stringify(items), value, cod ? 'cod' : 'prepaid',
        kmR, kmC, Math.max(2, Math.round(kmR * 5)), Math.max(4, Math.round(kmC * 4.5)), code4(), code4(), now(), now() + OFFER_TTL).lastInsertRowid;
      offer = one('SELECT * FROM orders WHERE id = ?', id);
    }
    res.json({ offer: orderView(offer), secondsLeft: Math.max(0, Math.ceil((offer.expires_at - now()) / 1000)) });
  }));

  app.get('/api/orders/active', requireAuth, wrap((req, res) => {
    const o = activeOrder(req.rider.id);
    res.json({ order: o ? orderView(o) : null });
  }));

  app.post('/api/orders/:id/accept', requireAuth, requireActive, wrap((req, res) => {
    const o = ownOrder(req, 'offered');
    if (o.expires_at < now()) { run(`UPDATE orders SET status='expired' WHERE id = ?`, o.id); throw conflict('This request has expired.', 'offer_expired'); }
    if (activeOrder(req.rider.id)) throw conflict('You already have an active order.', 'order_in_progress');
    run(`UPDATE orders SET status='accepted', accepted_at=? WHERE id = ?`, now(), o.id);
    res.json({ order: orderView(one('SELECT * FROM orders WHERE id = ?', o.id)) });
  }));
  app.post('/api/orders/:id/decline', requireAuth, requireActive, wrap((req, res) => {
    const o = ownOrder(req, 'offered');
    run(`UPDATE orders SET status='declined' WHERE id = ?`, o.id);
    res.json({ ok: true });
  }));

  const step = (path, from, to, extra) => app.post(`/api/orders/:id/${path}`, requireAuth, requireActive, wrap((req, res) => {
    const o = ownOrder(req, ...from);
    const patch = extra ? extra(o, req) : {};
    const sets = Object.keys({ status: to, ...patch });
    run(`UPDATE orders SET ${sets.map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values({ status: to, ...patch }), o.id);
    res.json({ order: orderView(one('SELECT * FROM orders WHERE id = ?', o.id)) });
  }));

  step('arrive', ['accepted'], 'at_restaurant', () => ({ arrived_rest_at: now() }));
  step('verify-pickup', ['at_restaurant'], 'verified', (o, req) => {
    if (!req.body?.skip && !safeEq(String(req.body?.code || ''), o.pickup_code)) throw bad('Code does not match. Ask the restaurant to confirm it.', 'code_mismatch');
    return {};
  });
  step('pickup', ['verified'], 'picked_up', (o, req) => {
    if (Array.isArray(req.body?.checked) && req.body.checked.length < 1) throw bad('Check the items first.', 'items_unchecked');
    return { picked_up_at: now() };
  });
  step('reached', ['picked_up'], 'at_customer');

  app.post('/api/orders/:id/contact', requireAuth, requireActive, wrap((req, res) => {
    const o = ownOrder(req, 'picked_up', 'at_customer');
    const body = String(req.body?.message || '').trim().slice(0, 200);
    if (!body) throw bad('Write a message first.', 'empty_message');
    run('INSERT INTO messages (order_id, body, created_at) VALUES (?,?,?)', o.id, body, now());
    res.status(201).json({ sent: true });
  }));

  step('deliver', ['at_customer'], 'delivered', (o, req) => {
    if (!req.body?.contactless && !safeEq(String(req.body?.otp || ''), o.drop_otp)) throw bad('Code does not match. Ask the customer to read it again.', 'code_mismatch');
    return { delivered_at: now() };
  });

  // Settles payment and writes the earnings lines atomically.
  app.post('/api/orders/:id/settle', requireAuth, requireActive, wrap((req, res) => {
    const o0 = ownOrder(req, 'delivered');
    const result = tx(() => {
      const o = one('SELECT * FROM orders WHERE id = ?', o0.id);
      if (o.status !== 'delivered') throw conflict('Already settled.', 'invalid_state');
      let cash = 0;
      if (o.payment_type === 'cod') {
        if (req.body?.cashCollected !== true) throw bad(`Collect ₹${o.order_value} from the customer first.`, 'cash_not_collected');
        cash = o.order_value;
      }
      const tip = [0, 0, 10, 20][randomInt(4)];
      const lines = earnLines({ ...o, tip }, now());
      for (const [label, amount] of lines) run('INSERT INTO earning_lines (order_id, rider_id, label, amount, created_at) VALUES (?,?,?,?,?)', o.id, o.rider_id, label, amount, now());
      run(`UPDATE orders SET status='settled', cash_collected=?, settled_at=? WHERE id = ?`, cash, now(), o.id);
      run('UPDATE riders SET cash_in_hand = cash_in_hand + ? WHERE id = ?', cash, o.rider_id);
      const total = lines.reduce((a, b) => a + b[1], 0);
      run(`UPDATE shifts SET deliveries = deliveries + 1, earnings = earnings + ? WHERE rider_id = ? AND ended_at IS NULL`, total, o.rider_id);
      return { lines, total };
    });
    const t = stats(req.rider.id, ymd(now()));
    res.json({ earnings: { lines: result.lines.map(([label, amount]) => ({ label, amount })), total: result.total }, today: t,
      bonus: { target: BONUS_TARGET, amount: BONUS, progress: Math.min(t.deliveries, BONUS_TARGET) },
      rider: riderView(one('SELECT * FROM riders WHERE id = ?', req.rider.id)) });
  }));

  app.get('/api/orders/:id/earnings', requireAuth, wrap((req, res) => {
    const o = ownOrder(req);
    const lines = all('SELECT label, amount FROM earning_lines WHERE order_id = ? ORDER BY id', o.id);
    res.json({ orderId: o.public_id, lines, total: lines.reduce((a, b) => a + b.amount, 0) });
  }));

  /* ---------- earnings + shift ---------- */
  app.get('/api/earnings', requireAuth, wrap((req, res) => {
    const since = req.query.range === 'week' ? ymd(now()) - 6 * 86400_000 : ymd(now());
    const rows = all(`SELECT o.public_id AS id, o.restaurant, o.settled_at AS at, SUM(e.amount) AS total
      FROM orders o JOIN earning_lines e ON e.order_id = o.id WHERE o.rider_id = ? AND o.settled_at >= ? GROUP BY o.id ORDER BY o.settled_at DESC`, req.rider.id, since);
    res.json({ ...stats(req.rider.id, since), orders: rows });
  }));

  app.post('/api/shift/end', requireAuth, requireActive, wrap((req, res) => {
    if (activeOrder(req.rider.id)) throw conflict('Finish your current delivery before ending the shift.', 'order_in_progress');
    const summary = tx(() => {
      const r = one('SELECT * FROM riders WHERE id = ?', req.rider.id);
      run(`UPDATE orders SET status='expired' WHERE rider_id = ? AND status = 'offered'`, r.id);
      const shift = one('SELECT * FROM shifts WHERE rider_id = ? AND ended_at IS NULL', r.id);
      run('UPDATE riders SET online = 0 WHERE id = ?', r.id);
      if (shift) run('UPDATE shifts SET ended_at = ? WHERE id = ?', now(), shift.id);
      const mins = shift ? Math.max(0, Math.round(((now()) - shift.started_at) / 60_000)) : 0;
      const t = stats(r.id, ymd(now()));
      return { deliveries: t.deliveries, earnings: t.earnings, onlineMinutes: mins, averagePerOrder: t.deliveries ? Math.round(t.earnings / t.deliveries) : 0,
        cashInHand: r.cash_in_hand, ...rates(r.id) };
    });
    res.json({ summary, rider: riderView(one('SELECT * FROM riders WHERE id = ?', req.rider.id)) });
  }));

  /* ---------- errors ---------- */
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.', code: 'not_found' }));
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.', code: 'bad_json' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side.', code: 'server_error' });
  });
  return app;
}
