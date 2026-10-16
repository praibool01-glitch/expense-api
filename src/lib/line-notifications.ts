import { config } from '../config.js';
import { pool } from '../db.js';

type Notification = {
  householdId: string;
  message: string;
};

type MemberRow = {
  line_user_id: string;
};

const MAX_RECIPIENTS_PER_REQUEST = 500;

export async function notifyHousehold({ householdId, message }: Notification) {
  const { rows } = await pool.query<MemberRow>(
    `select u.line_user_id
       from household_members hm
       join users u on u.id = hm.user_id
      where hm.household_id = $1`,
    [householdId],
  );

  // DEV_AUTH IDs are local test identities and cannot receive LINE messages.
  const devAuthMemberCount = rows.filter((row) => row.line_user_id.startsWith('dev:')).length;
  const recipients = rows
    .map((row) => row.line_user_id)
    .filter((id) => !id.startsWith('dev:'));
  if (recipients.length === 0) {
    console.warn('LINE notification skipped: no eligible recipients', {
      memberCount: rows.length,
      devAuthMemberCount,
    });
    return;
  }
  if (!config.lineChannelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not configured');
  }

  const failures: string[] = [];
  for (let i = 0; i < recipients.length; i += MAX_RECIPIENTS_PER_REQUEST) {
    const userIds = recipients.slice(i, i + MAX_RECIPIENTS_PER_REQUEST);
    try {
      const response = await fetch('https://api.line.me/v2/bot/message/multicast', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.lineChannelAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: userIds, messages: [{ type: 'text', text: message }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const details = await response.text();
        failures.push(
          `batch ${Math.floor(i / MAX_RECIPIENTS_PER_REQUEST) + 1}: HTTP ${response.status}${
            details ? ` ${details}` : ''
          }`,
        );
      }
    } catch (error) {
      failures.push(
        `batch ${Math.floor(i / MAX_RECIPIENTS_PER_REQUEST) + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`LINE multicast notification failed (${failures.join('; ')})`);
  }

  console.info('LINE multicast request accepted', {
    recipientCount: recipients.length,
    batchCount: Math.ceil(recipients.length / MAX_RECIPIENTS_PER_REQUEST),
  });
}

export function formatNotificationAmount(amountSatang: number) {
  const baht = Math.floor(amountSatang / 100).toLocaleString('th-TH');
  const satang = String(amountSatang % 100).padStart(2, '0');
  return `${baht}.${satang} บาท`;
}

function cleanNotificationName(name: string) {
  return name.replace(/[\r\n\t]+/g, ' ').trim();
}

export function formatIncomeNotification({
  name,
  amountSatang,
  month,
}: {
  name: string;
  amountSatang: number;
  month: string;
}) {
  return [
    '🟢 เงินเข้า',
    '',
    `📌 ${cleanNotificationName(name)}`,
    `💰 +${formatNotificationAmount(amountSatang)}`,
    `📅 เดือน ${month}`,
  ].join('\n');
}

export function formatExpenseNotification({
  name,
  amountSatang,
  month,
}: {
  name: string;
  amountSatang: number | null;
  month: string;
}) {
  return [
    '🔴 เงินออก',
    '',
    `📌 ${cleanNotificationName(name)}`,
    amountSatang === null
      ? '💸 กลุ่มรายจ่าย (ยอดรวมคำนวณจากรายการย่อย)'
      : `💸 -${formatNotificationAmount(amountSatang)}`,
    `📅 เดือน ${month}`,
  ].join('\n');
}
