import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { HttpError } from '../lib/errors.js';
import { setClauses } from '../lib/sql.js';
import { idSchema, monthSchema, parse } from '../lib/validate.js';
import { formatNotificationAmount, notifyHousehold } from '../lib/line-notifications.js';
import type { Entry, Env } from '../types.js';

export const entries = new Hono<Env>();
entries.use('*', requireAuth);

export type EntryRow = {
  id: string;
  parent_id: string | null;
  name: string;
  amount_satang: number | null;
  category_id: string | null;
  note: string | null;
  is_paid: boolean;
  created_by: string | null;
  sort_order: number;
  created_at: Date;
};
export const ENTRY_COLS =
  'id, parent_id, name, amount_satang, category_id, note, is_paid, created_by, sort_order, created_at';

export const toEntry = (r: EntryRow): Entry => ({
  id: r.id,
  parentId: r.parent_id,
  name: r.name,
  amountSatang: r.amount_satang,
  totalSatang: r.amount_satang ?? 0,
  categoryId: r.category_id,
  note: r.note,
  isPaid: r.is_paid,
  createdBy: r.created_by,
  sortOrder: r.sort_order,
  createdAt: r.created_at.toISOString(),
});

const amount = z.number().int().min(0);
const createSchema = z.object({
  month: monthSchema,
  parentId: idSchema.nullable().optional(),
  name: z.string().trim().min(1).max(100),
  amountSatang: amount.nullable().optional(),
  categoryId: idSchema.nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  isPaid: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
const patchSchema = z.object({
  parentId: idSchema.nullable().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  amountSatang: amount.nullable().optional(),
  categoryId: idSchema.nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  isPaid: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const COLUMNS = {
  parentId: 'parent_id',
  name: 'name',
  amountSatang: 'amount_satang',
  categoryId: 'category_id',
  note: 'note',
  isPaid: 'is_paid',
  sortOrder: 'sort_order',
};

// หมวดต้องเป็นของบ้านเดียวกัน
async function assertCategory(householdId: string, categoryId: string) {
  const { rowCount } = await pool.query('select 1 from categories where id = $1 and household_id = $2', [
    categoryId,
    householdId,
  ]);
  if (!rowCount) throw new HttpError(400, 'VALIDATION_ERROR', 'ไม่พบหมวดนี้', { categoryId: 'invalid' });
}

// "กลุ่ม" ที่เป็นแม่ได้ ต้องเป็นแถวระดับบนสุด ไม่มียอด และอยู่ในเดือนเดียวกันของบ้านเดียวกัน
async function assertValidParent(householdId: string, parentId: string, monthDate: string) {
  const { rows } = await pool.query<{ parent_id: string | null; amount_satang: number | null; month: string }>(
    'select parent_id, amount_satang, month from entries where id = $1 and household_id = $2',
    [parentId, householdId],
  );
  const parent = rows[0];
  if (!parent) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบกลุ่มที่เลือก');
  if (parent.parent_id !== null || parent.amount_satang !== null || parent.month !== monthDate) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'กลุ่มที่เลือกไม่ถูกต้อง', { parentId: 'invalid' });
  }
}

// ยอดของแถวกลุ่ม = ผลรวมของลูก
async function withTotal(row: EntryRow): Promise<Entry> {
  const entry = toEntry(row);
  if (row.amount_satang === null) {
    const { rows } = await pool.query<{ total: number }>(
      'select coalesce(sum(amount_satang), 0) as total from entries where parent_id = $1',
      [row.id],
    );
    entry.totalSatang = rows[0].total;
  }
  return entry;
}

entries.post('/', async (c) => {
  const { householdId, userId } = c.get('auth');
  const b = parse(createSchema, await c.req.json().catch(() => null));
  const monthDate = `${b.month}-01`;
  const amountSatang = b.amountSatang ?? null;
  const parentId = b.parentId ?? null;

  if (parentId !== null) {
    if (amountSatang === null) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'รายการในกลุ่มต้องมีจำนวนเงิน', {
        amountSatang: 'required',
      });
    }
    await assertValidParent(householdId, parentId, monthDate);
  }
  if (b.categoryId) await assertCategory(householdId, b.categoryId);

  const { rows } = await pool.query<EntryRow>(
    `insert into entries
       (household_id, month, parent_id, name, amount_satang, category_id, note, is_paid, created_by, sort_order)
     values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9,
       coalesce($10::int,
         (select coalesce(max(sort_order), 0) + 1 from entries where household_id = $1 and month = $2::date)))
     returning ${ENTRY_COLS}`,
    [
      householdId,
      monthDate,
      parentId,
      b.name,
      amountSatang,
      b.categoryId ?? null,
      b.note ?? null,
      b.isPaid ?? false,
      userId,
      b.sortOrder ?? null,
    ],
  );
  const entry = await withTotal(rows[0]);
  const expenseAmount =
    amountSatang === null ? 'กลุ่มรายจ่าย (ยอดรวมคำนวณจากรายการย่อย)' : formatNotificationAmount(amountSatang);
  try {
    await notifyHousehold({
      householdId,
      message: `มีการเพิ่มรายจ่าย\nรายการ: ${b.name}\nจำนวน: ${expenseAmount}\nเดือน: ${b.month}`,
    });
  } catch (error) {
    console.error('Failed to send LINE notification for new expense entry', error);
  }
  return c.json(entry, 201);
});

entries.patch('/:id', async (c) => {
  const { householdId } = c.get('auth');
  const id = parse(idSchema, c.req.param('id'));
  const b = parse(patchSchema, await c.req.json().catch(() => null));

  const found = await pool.query<EntryRow & { month: string }>(
    `select ${ENTRY_COLS}, month from entries where id = $1 and household_id = $2`,
    [id, householdId],
  );
  const current = found.rows[0];
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบรายการนี้');

  const childCount = (
    await pool.query<{ n: number }>('select count(*) as n from entries where parent_id = $1', [id])
  ).rows[0].n;

  // ตรวจกฎแม่-ลูกจากสถานะ "หลังแก้"
  const finalParent = b.parentId !== undefined ? b.parentId : current.parent_id;
  const finalAmount = b.amountSatang !== undefined ? b.amountSatang : current.amount_satang;

  if (childCount > 0 && (finalAmount !== null || finalParent !== null)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'กลุ่มที่มีรายการย่อยต้องไม่มียอดและไม่อยู่ในกลุ่มอื่น');
  }
  if (finalParent !== null) {
    if (finalParent === id) throw new HttpError(400, 'VALIDATION_ERROR', 'เลือกตัวเองเป็นกลุ่มไม่ได้');
    if (finalAmount === null) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'รายการในกลุ่มต้องมีจำนวนเงิน', { amountSatang: 'required' });
    }
    await assertValidParent(householdId, finalParent, current.month);
  }
  if (b.categoryId) await assertCategory(householdId, b.categoryId);

  const { sets, params } = setClauses(COLUMNS, b, 3);
  if (sets.length === 0) throw new HttpError(400, 'VALIDATION_ERROR', 'ไม่มีข้อมูลที่จะแก้ไข');

  const { rows } = await pool.query<EntryRow>(
    `update entries set ${sets.join(', ')} where id = $1 and household_id = $2 returning ${ENTRY_COLS}`,
    [id, householdId, ...params],
  );
  return c.json(await withTotal(rows[0]));
});

// ลบแม่แล้วลูกหายตาม (on delete cascade)
entries.delete('/:id', async (c) => {
  const { householdId } = c.get('auth');
  const id = parse(idSchema, c.req.param('id'));
  const res = await pool.query('delete from entries where id = $1 and household_id = $2', [id, householdId]);
  if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบรายการนี้');
  return c.body(null, 204);
});
