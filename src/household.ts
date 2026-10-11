import type { PoolClient } from 'pg';

const DEFAULT_CATEGORIES = [
  { name: 'ค่าใช้จ่ายคงที่', color: '#E07A6B' },
  { name: 'ค่ากิน', color: '#5FB59E' },
  { name: 'ค่าเที่ยว', color: '#B493C4' },
  { name: 'ของใช้จุกจิก', color: '#E3B948' },
];

// สร้างครอบครัวใหม่ให้ผู้ใช้ (เป็นเจ้าของ) พร้อมหมวดเริ่มต้น
// ใช้ตอนล็อกอินครั้งแรก และตอนผู้ใช้ถูกนำออก/ออกจากบ้านเดิม (ผู้ใช้จะได้ไม่ไร้บ้าน)
export async function createHouseholdFor(db: PoolClient, userId: string, name = 'บ้านของเรา') {
  const h = await db.query<{ id: string; name: string }>(
    'insert into households (name) values ($1) returning id, name',
    [name],
  );
  const household = h.rows[0];
  await db.query(
    "insert into household_members (household_id, user_id, role) values ($1, $2, 'owner')",
    [household.id, userId],
  );
  for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
    await db.query(
      'insert into categories (household_id, name, color, sort_order) values ($1, $2, $3, $4)',
      [household.id, c.name, c.color, i + 1],
    );
  }
  return household;
}
