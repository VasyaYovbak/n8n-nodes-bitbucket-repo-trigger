import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(secret: string, rawBody: unknown, signature: unknown): boolean {
  if (!secret || (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string')) return false;
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const received = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function settingsFingerprint(workspace: string, repository: string, url: string, events: string[], secret: string): string {
  return createHash('sha256').update(JSON.stringify([workspace, repository, url, [...events].sort(), secret])).digest('hex');
}

export function normalizeHookId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i.exec(value);
  if (!match || value.startsWith('{') !== value.endsWith('}')) return null;
  return match[1].toLowerCase();
}
