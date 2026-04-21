import pino from 'pino';
import { config } from '../config.js';

export const logger = pino(
  config.NODE_ENV === 'production'
    ? { level: 'info' }
    : config.NODE_ENV === 'test'
      ? { level: 'silent' }
      : {
          level: 'debug',
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        },
);
