// สร้างส่วน SET ของ UPDATE จาก field ที่ส่งมาเท่านั้น
// ชื่อคอลัมน์มาจาก map ที่เรากำหนดเอง ไม่ได้มาจากผู้ใช้ จึงไม่เสี่ยง SQL injection
export function setClauses(
  columns: Record<string, string>,
  patch: Record<string, unknown>,
  firstParam: number,
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (value === undefined || !column) continue;
    params.push(value);
    sets.push(`${column} = $${firstParam + params.length - 1}`);
  }
  return { sets, params };
}
