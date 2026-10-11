import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.js';
import { tx } from '../db.js';
import { signSession } from '../auth.js';
import { createHouseholdFor } from '../household.js';
import { HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

export const auth = new Hono();

// เข้าสู่ระบบครั้งแรก: สร้าง user + ครอบครัว + หมวดเริ่มต้นให้อัตโนมัติ
async function loginOrCreate(lineUserId: string, displayName: string | null) {
  return tx(async (db) => {
    const u = await db.query<{ id: string; display_name: string | null }>(
      `insert into users (line_user_id, display_name) values ($1, $2)
       on conflict (line_user_id)
       do update set display_name = coalesce(excluded.display_name, users.display_name)
       returning id, display_name`,
      [lineUserId, displayName],
    );
    const user = u.rows[0];

    const m = await db.query<{ household_id: string; name: string; role: string }>(
      `select hm.household_id, h.name, hm.role
         from household_members hm join households h on h.id = hm.household_id
        where hm.user_id = $1`,
      [user.id],
    );

    const household = m.rows[0]
      ? { id: m.rows[0].household_id, name: m.rows[0].name, role: m.rows[0].role }
      : { ...(await createHouseholdFor(db, user.id)), role: 'owner' };

    return { user: { id: user.id, displayName: user.display_name }, household };
  });
}

async function verifyLineIdToken(idToken: string) {
  if (!config.lineChannelId) {
    throw new HttpError(500, 'INTERNAL', 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ID');
  }
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: config.lineChannelId }),
  });
  if (!res.ok) throw new HttpError(401, 'UNAUTHENTICATED', 'LINE ID token ไม่ถูกต้อง');
  return (await res.json()) as { sub: string; name?: string };
}

// แลก LINE ID token เป็น session token ของระบบเรา
auth.post('/line', async (c) => {
  const { idToken } = parse(z.object({ idToken: z.string().min(1) }), await c.req.json().catch(() => null));
  const line = await verifyLineIdToken(idToken);
  const result = await loginOrCreate(line.sub, line.name ?? null);
  return c.json({ token: await signSession(result.user.id), ...result });
});

// ทางเข้าสำหรับทดสอบโดยไม่ต้องมี LINE (เปิดด้วย DEV_AUTH=true เท่านั้น)
if (config.devAuth) {
  console.warn('⚠️  DEV_AUTH เปิดอยู่: POST /api/v1/auth/dev ใช้ล็อกอินเป็นใครก็ได้ ห้ามเปิดบน production');
  auth.post('/dev', async (c) => {
    const body = parse(
      z.object({ lineUserId: z.string().min(1).max(100), displayName: z.string().max(100).optional() }),
      await c.req.json().catch(() => null),
    );
    const result = await loginOrCreate(`dev:${body.lineUserId}`, body.displayName ?? null);
    return c.json({ token: await signSession(result.user.id), ...result });
  });
}
