import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { auth } from './routes/auth.js';
import { me } from './routes/me.js';
import { categories } from './routes/categories.js';
import { months } from './routes/months.js';
import { entries } from './routes/entries.js';
import { incomes } from './routes/incomes.js';
import { household, invites } from './routes/household.js';

const app = new Hono();

app.use(
  '*',
  cors({
    origin: config.corsOrigin,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

const api = new Hono();
api.route('/auth', auth);
api.route('/me', me);
api.route('/categories', categories);
api.route('/months', months);
api.route('/entries', entries);
api.route('/incomes', incomes);
api.route('/household', household);
api.route('/invites', invites);
app.route('/api/v1', api);

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'ไม่พบ endpoint นี้' } }, 404));

// รูปแบบ error เดียวกันทั้งระบบตาม API contract
app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } },
      err.status,
    );
  }
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
    return c.json({ error: { code: 'CONFLICT', message: 'ข้อมูลซ้ำกับที่มีอยู่แล้ว' } }, 409);
  }
  console.error(err);
  return c.json({ error: { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' } }, 500);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API พร้อมที่ http://localhost:${info.port}`);
});
