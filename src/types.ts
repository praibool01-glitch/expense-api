export type Auth = { userId: string; householdId: string; role: 'owner' | 'member' };
export type Env = { Variables: { auth: Auth } };

// รูปแบบตอบกลับตาม API contract (camelCase)
export type Entry = {
  id: string;
  parentId: string | null;
  name: string;
  amountSatang: number | null;
  totalSatang: number;
  categoryId: string | null;
  note: string | null;
  isPaid: boolean;
  createdBy: string | null;
  sortOrder: number;
  children?: Entry[];
};
