import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { openDb } from './db.js';
import { createApp } from './app.js';

const db = openDb();
const api = createApp(db);
const server = express();
server.use(api);

// Serve the web build of the app too, so one process runs everything.
const www = join(dirname(fileURLToPath(import.meta.url)), '../../app/www');
if (existsSync(www)) server.use(express.static(www));

// Housekeeping: drop expired OTPs and sessions.
setInterval(() => {
  const t = Date.now();
  db.prepare('DELETE FROM otps WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
}, 10 * 60_000).unref();

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`RiderGo API on http://localhost:${port}  (demo mode: ${process.env.DEMO_MODE !== '0'})`));
