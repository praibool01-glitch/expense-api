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
  const recipients = rows.map((row) => row.line_user_id).filter((id) => !id.startsWith('dev:'));
  if (recipients.length === 0) return;
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
}

export function formatNotificationAmount(amountSatang: number) {
  const baht = Math.floor(amountSatang / 100).toLocaleString('th-TH');
  const satang = String(amountSatang % 100).padStart(2, '0');
  return `${baht}.${satang} บาท`;
}
