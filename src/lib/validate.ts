import { z } from 'zod';
import { HttpError } from './errors.js';

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'ต้องเป็นรูปแบบ YYYY-MM');
export const idSchema = z.string().uuid();

// ตรวจข้อมูลด้วย zod ถ้าไม่ผ่านให้ตอบ 400 พร้อมบอกว่าผิดที่ field ไหน
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      fields[key] ??= issue.message;
    }
    throw new HttpError(400, 'VALIDATION_ERROR', 'ข้อมูลไม่ถูกต้อง', fields);
  }
  return result.data;
}
