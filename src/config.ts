const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
};

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtSecret: required('JWT_SECRET'),
  lineChannelId: process.env.LINE_CHANNEL_ID ?? '',
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
  devAuth: process.env.DEV_AUTH === 'true',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  // ที่อยู่ที่ลิงก์เชิญจะพาไปเปิด (ตอนใช้ LIFF ให้เป็น https://liff.line.me/<liffId>)
  appUrl: process.env.APP_URL ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173',
};

if (config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}
