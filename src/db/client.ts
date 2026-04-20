import { PrismaClient } from '@prisma/client';
import { config } from '../config.js';

// Keep a single PrismaClient across hot-reloads in dev so we don't
// open a new connection pool every time tsx/vitest re-imports this module.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prisma ??
  new PrismaClient({
    log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (config.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}
