import { Hono } from 'hono';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { monthSchema, parse } from '../lib/validate.js';
import { ENTRY_COLS, toEntry, type EntryRow } from './entries.js';
import type { Entry, Env } from '../types.js';

export const months = new Hono<Env>();
months.use('*', requireAuth);

// ดึงทั้งเดือนในครั้งเดียว: รายการ (เป็น tree) + เงินเข้า + สรุป
months.get('/:month', async (c) => {
  const { householdId } = c.get('auth');
  const month = parse(monthSchema, c.req.param('month'));
  const monthDate = `${month}-01`;

  const [entryRes, incomeRes, summaryRes] = await Promise.all([
    pool.query<EntryRow>(
      `select ${ENTRY_COLS} from entries
        where household_id = $1 and month = $2::date
        order by amount_satang asc nulls first, created_at desc, sort_order desc`,
      [householdId, monthDate],
    ),
    pool.query<{
      id: string;
      name: string;
      amount_satang: number;
      created_by: string | null;
      created_at: Date | null;
    }>(
      `select id, name, amount_satang, created_by, created_at from incomes
        where household_id = $1 and month = $2::date
        order by name, id`,
      [householdId, monthDate],
    ),
    pool.query<{ category_id: string | null; total_satang: number; paid_satang: number }>(
      `select category_id, total_satang, coalesce(paid_satang, 0) as paid_satang
         from monthly_category_totals
        where household_id = $1 and month = $2::date`,
      [householdId, monthDate],
    ),
  ]);

  // ประกอบ tree แม่-ลูก และคำนวณยอดรวมของแม่ที่ backend (หน้าบ้านไม่ต้องบวกเอง)
  const roots: Entry[] = [];
  const kidsOf = new Map<string, Entry[]>();
  for (const row of entryRes.rows) {
    const entry = toEntry(row);
    if (row.parent_id) {
      const list = kidsOf.get(row.parent_id) ?? [];
      list.push(entry);
      kidsOf.set(row.parent_id, list);
    } else {
      roots.push(entry);
    }
  }
  for (const root of roots) {
    const kids = kidsOf.get(root.id);
    if (kids && kids.length > 0) {
      root.children = kids;
      root.totalSatang = kids.reduce((sum, k) => sum + k.totalSatang, 0);
    }
  }

  const byCategory = summaryRes.rows.map((r) => ({
    categoryId: r.category_id,
    totalSatang: r.total_satang,
    paidSatang: r.paid_satang,
  }));
  const totalExpenseSatang = byCategory.reduce((s, r) => s + r.totalSatang, 0);
  const totalPaidSatang = byCategory.reduce((s, r) => s + r.paidSatang, 0);
  const totalIncomeSatang = incomeRes.rows.reduce((s, r) => s + r.amount_satang, 0);

  return c.json({
    month,
    entries: roots,
    incomes: incomeRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      amountSatang: r.amount_satang,
      createdBy: r.created_by,
      createdAt: r.created_at?.toISOString() ?? null,
    })),
    summary: {
      totalExpenseSatang,
      totalPaidSatang,
      totalIncomeSatang,
      remainingSatang: totalIncomeSatang - totalExpenseSatang,
      byCategory,
    },
  });
});
