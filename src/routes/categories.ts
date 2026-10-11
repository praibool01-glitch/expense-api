import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { HttpError } from '../lib/errors.js';
import { setClauses } from '../lib/sql.js';
import { idSchema, parse } from '../lib/validate.js';
import type { Env } from '../types.js';

export const categories = new Hono<Env>();
categories.use('*', requireAuth);

type Row = { id: string; name: string; color: string | null; sort_order: number };
const COLS = 'id, name, color, sort_order';
const toCategory = (r: Row) => ({ id: r.id, name: r.name, color: r.color, sortOrder: r.sort_order });

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'ต้องเป็นสีแบบ #RRGGBB');
const createSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: color.optional(),
  sortOrder: z.number().int().optional(),
});
const patchSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  color: color.optional(),
  sortOrder: z.number().int().optional(),
});

categories.get('/', async (c) => {
  const { householdId } = c.get('auth');
  const { rows } = await pool.query<Row>(
    `select ${COLS} from categories where household_id = $1 order by sort_order, name`,
    [householdId],
  );
  return c.json(rows.map(toCategory));
});

categories.post('/', async (c) => {
  const { householdId } = c.get('auth');
  const b = parse(createSchema, await c.req.json().catch(() => null));
  const { rows } = await pool.query<Row>(
    `insert into categories (household_id, name, color, sort_order)
     values ($1, $2, $3, coalesce($4::int,
       (select coalesce(max(sort_order), 0) + 1 from categories where household_id = $1)))
     returning ${COLS}`,
    [householdId, b.name, b.color ?? '#9AA5A1', b.sortOrder ?? null],
  );
  return c.json(toCategory(rows[0]), 201); // ชื่อซ้ำในบ้านเดียวกัน -> 409 จาก error handler
});

categories.patch('/:id', async (c) => {
  const { householdId } = c.get('auth');
  const id = parse(idSchema, c.req.param('id'));
  const b = parse(patchSchema, await c.req.json().catch(() => null));
  const { sets, params } = setClauses({ name: 'name', color: 'color', sortOrder: 'sort_order' }, b, 3);
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION_ERROR', 'ไม่มีข้อมูลที่จะแก้ไข');

  const { rows } = await pool.query<Row>(
    `update categories set ${sets.join(', ')} where id = $1 and household_id = $2 returning ${COLS}`,
    [id, householdId, ...params],
  );
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบหมวดนี้');
  return c.json(toCategory(rows[0]));
});

// รายการที่ใช้หมวดนี้จะกลายเป็น "ไม่มีหมวด" (on delete set null)
categories.delete('/:id', async (c) => {
  const { householdId } = c.get('auth');
  const id = parse(idSchema, c.req.param('id'));
  const res = await pool.query('delete from categories where id = $1 and household_id = $2', [id, householdId]);
  if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบหมวดนี้');
  return c.body(null, 204);
});
