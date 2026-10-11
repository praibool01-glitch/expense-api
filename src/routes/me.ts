import { Hono } from 'hono';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import type { Env } from '../types.js';

export const me = new Hono<Env>();
me.use('*', requireAuth);

me.get('/', async (c) => {
  const { userId, householdId, role } = c.get('auth');
  const { rows } = await pool.query<{ display_name: string | null; household_name: string }>(
    `select u.display_name, h.name as household_name
       from users u, households h where u.id = $1 and h.id = $2`,
    [userId, householdId],
  );
  return c.json({
    user: { id: userId, displayName: rows[0].display_name },
    household: { id: householdId, name: rows[0].household_name, role },
  });
});
