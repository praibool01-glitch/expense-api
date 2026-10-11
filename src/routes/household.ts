import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { requireAuth } from '../auth.js';
import { createHouseholdFor } from '../household.js';
import { HttpError } from '../lib/errors.js';
import { idSchema, parse } from '../lib/validate.js';
import type { Env } from '../types.js';

export const household = new Hono<Env>();
household.use('*', requireAuth);

export const invites = new Hono<Env>();
invites.use('*', requireAuth);

function requireOwner(role: 'owner' | 'member') {
  if (role !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'เฉพาะเจ้าของบ้านที่ทำได้');
}

household.get('/', async (c) => {
  const { userId, householdId, role } = c.get('auth');
  const h = await pool.query<{ name: string }>('select name from households where id = $1', [householdId]);
  const m = await pool.query<{ user_id: string; display_name: string | null; role: 'owner' | 'member' }>(
    `select hm.user_id, u.display_name, hm.role
       from household_members hm join users u on u.id = hm.user_id
      where hm.household_id = $1
      order by (hm.role = 'owner') desc, hm.joined_at`,
    [householdId],
  );
  return c.json({
    id: householdId,
    name: h.rows[0].name,
    myRole: role,
    members: m.rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      role: r.role,
      isMe: r.user_id === userId,
    })),
  });
});

household.patch('/', async (c) => {
  const { householdId, role } = c.get('auth');
  requireOwner(role);
  const { name } = parse(
    z.object({ name: z.string().trim().min(1).max(50) }),
    await c.req.json().catch(() => null),
  );
  await pool.query('update households set name = $1 where id = $2', [name, householdId]);
  return c.json({ id: householdId, name });
});

// สร้างลิงก์เชิญ: ใช้ได้ครั้งเดียว อายุ 7 วัน
household.post('/invites', async (c) => {
  const { householdId, userId, role } = c.get('auth');
  requireOwner(role);
  const code = randomBytes(18).toString('base64url'); // 24 ตัวอักษร เดาไม่ได้
  const { rows } = await pool.query<{ expires_at: Date }>(
    `insert into invites (household_id, code, created_by, expires_at)
     values ($1, $2, $3, now() + interval '7 days') returning expires_at`,
    [householdId, code, userId],
  );
  const url = new URL(config.appUrl);
  url.searchParams.set('invite', code);
  return c.json({ code, url: url.toString(), expiresAt: rows[0].expires_at }, 201);
});

// เจ้าของนำสมาชิกออก หรือสมาชิกออกจากบ้านเอง
// คนที่ออกจะได้ครอบครัวใหม่ที่ว่างเปล่าทันที จะได้ไม่เจอสถานะไม่มีบ้าน
household.delete('/members/:userId', async (c) => {
  const { userId: me, householdId, role } = c.get('auth');
  const target = parse(idSchema, c.req.param('userId'));
  const isSelf = target === me;

  if (!isSelf) requireOwner(role);
  if (isSelf && role === 'owner') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'เจ้าของบ้านออกจากบ้านเองไม่ได้');
  }

  await tx(async (db) => {
    const res = await db.query(
      "delete from household_members where household_id = $1 and user_id = $2 and role = 'member'",
      [householdId, target],
    );
    if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบสมาชิกคนนี้');
    await createHouseholdFor(db, target);
  });
  return c.body(null, 204);
});

// รับคำเชิญ: ย้ายผู้ใช้เข้าบ้านของผู้เชิญ
invites.post('/accept', async (c) => {
  const { userId, householdId } = c.get('auth');
  const { code } = parse(
    z.object({ code: z.string().min(10).max(100) }),
    await c.req.json().catch(() => null),
  );

  const joined = await tx(async (db) => {
    const inv = await db.query<{ id: string; household_id: string }>(
      `select id, household_id from invites
        where code = $1 and used_at is null and expires_at > now()
        for update`,
      [code],
    );
    const invite = inv.rows[0];
    if (!invite) {
      throw new HttpError(404, 'NOT_FOUND', 'ลิงก์เชิญไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว');
    }
    if (invite.household_id === householdId) {
      throw new HttpError(409, 'CONFLICT', 'คุณอยู่ในบ้านนี้แล้ว');
    }

    // ตอน MVP หนึ่งคนอยู่ได้บ้านเดียว จึงต้องปล่อยบ้านเดิมก่อน
    // ป้องกันข้อมูลหาย: ยอมให้ทิ้งเฉพาะบ้านที่มีแค่ตัวเองและยังไม่มีรายการ
    const members = (
      await db.query<{ n: number }>('select count(*) as n from household_members where household_id = $1', [
        householdId,
      ])
    ).rows[0].n;
    if (members > 1) {
      throw new HttpError(409, 'CONFLICT', 'คุณอยู่ในบ้านที่มีสมาชิกคนอื่นอยู่ ต้องออกจากบ้านเดิมก่อน');
    }
    const used = (
      await db.query<{ n: number }>(
        `select (select count(*) from entries where household_id = $1)
              + (select count(*) from incomes where household_id = $1) as n`,
        [householdId],
      )
    ).rows[0].n;
    if (used > 0) {
      throw new HttpError(409, 'CONFLICT', 'บ้านเดิมของคุณมีรายการอยู่แล้ว ย้ายแล้วข้อมูลเดิมจะหาย');
    }

    await db.query('delete from households where id = $1', [householdId]);
    await db.query(
      "insert into household_members (household_id, user_id, role) values ($1, $2, 'member')",
      [invite.household_id, userId],
    );
    await db.query('update invites set used_by = $1, used_at = now() where id = $2', [userId, invite.id]);

    const h = await db.query<{ id: string; name: string }>('select id, name from households where id = $1', [
      invite.household_id,
    ]);
    return h.rows[0];
  });

  return c.json({ id: joined.id, name: joined.name, role: 'member' });
});
