import { SignJWT, jwtVerify } from 'jose';
import { createMiddleware } from 'hono/factory';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './lib/errors.js';
import type { Env } from './types.js';

const key = new TextEncoder().encode(config.jwtSecret);

// session token ของระบบเราเอง (LINE ID token อายุสั้น จึงไม่ส่งทุก request)
export const signSession = (userId: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key);

async function verifySession(token: string) {
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
  if (!payload.sub) throw new Error('missing sub');
  return payload.sub;
}

// ทุก endpoint ที่ต้องล็อกอินใช้ middleware นี้ และเซ็ต auth (userId + householdId) ให้
// household มาจาก token + DB เท่านั้น ไม่รับจาก frontend
export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'ต้องเข้าสู่ระบบ');

  let userId: string;
  try {
    userId = await verifySession(token);
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED', 'session หมดอายุหรือไม่ถูกต้อง');
  }

  const { rows } = await pool.query<{ household_id: string; role: 'owner' | 'member' }>(
    'select household_id, role from household_members where user_id = $1',
    [userId],
  );
  const membership = rows[0];
  if (!membership) throw new HttpError(403, 'FORBIDDEN', 'ผู้ใช้ยังไม่อยู่ในครอบครัวใด');

  c.set('auth', { userId, householdId: membership.household_id, role: membership.role });
  await next();
});
