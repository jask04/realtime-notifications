import { createApp } from './app.js';
import { config } from './config.js';

const app = await createApp();

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
