import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { HttpError } from '../lib/errors.js';
import { setClauses } from '../lib/sql.js';
import { idSchema, monthSchema, parse } from '../lib/validate.js';
import { formatIncomeNotification, notifyHousehold } from '../lib/line-notifications.js';
import type { Env } from '../types.js';

export const incomes = new Hono<Env>();
incomes.use('*', requireAuth);

type Row = {
  id: string;
  name: string;
  amount_satang: number;
  created_by: string | null;
  created_at: Date | null;
};
const COLS = 'id, name, amount_satang, created_by, created_at';
const toIncome = (r: Row) => ({
  id: r.id,
  name: r.name,
  amountSatang: r.amount_satang,
  createdBy: r.created_by,
  createdAt: r.created_at?.toISOString() ?? null,
});

const name = z.string().trim().min(1).max(100);
const amount = z.number().int().min(0);
const createSchema = z.object({ month: monthSchema, name, amountSatang: amount });
const patchSchema = z.object({ name: name.optional(), amountSatang: amount.optional() });

incomes.post('/', async (c) => {
  const { householdId, userId } = c.get('auth');
  const b = parse(createSchema, await c.req.json().catch(() => null));
  const { rows } = await pool.query<Row>(
    `insert into incomes (household_id, month, name, amount_satang, created_by)
     values ($1, $2::date, $3, $4, $5) returning ${COLS}`,
    [householdId, `${b.month}-01`, b.name, b.amountSatang, userId],
  );
  try {
    await notifyHousehold({
      householdId,
      message: formatIncomeNotification({
        name: b.name,
        amountSatang: b.amountSatang,
        month: b.month,
      }),
    });
  } catch (error) {
    console.error('Failed to send LINE notification for new income', error);
  }
  return c.json(toIncome(rows[0]), 201);
});

incomes.patch('/:id', async (c) => {
  const { householdId } = c.get('auth');
  const id = parse(idSchema, c.req.param('id'));
  const b = parse(patchSchema, await c.req.json().catch(() => null));
  const { sets, params } = setClauses({ name: 'name', amountSatang: 'amount_satang' }, b, 3);
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION_ERROR', 'ไม่มีข้อมูลที่จะแก้ไข');

  const { rows } = await pool.query<Row>(
    `update incomes set ${sets.join(', ')} where id = $1 and household_id = $2 returning ${COLS}`,
    [id, householdId, ...params],
  );
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบรายรับนี้');
  return c.json(toIncome(rows[0]));
});

incomes.delete('/:id', async (c) => {
  const { householdId } = c.get('auth');
  const id = parse(idSchema, c.req.param('id'));
  const res = await pool.query('delete from incomes where id = $1 and household_id = $2', [id, householdId]);
  if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบรายรับนี้');
  return c.body(null, 204);
});
