import { randomBytes } from 'node:crypto';
export const newId = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`;
export const now = (): number => Date.now();
