import pg from 'pg';
import { config } from './config.js';

// pg คืน bigint / numeric เป็นสตริง และ date เป็น Date (ตามเขตเวลา) แปลงให้ใช้ง่ายและไม่เพี้ยน
pg.types.setTypeParser(20, (v) => Number(v)); // int8 (amount_satang)
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (ผลของ sum)
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback');
    throw err;
  } finally {
    db.release();
  }
}
