import { createApp } from './bootstrap/create-app.js';

const app = await createApp();
await app.listen(
  Number(process.env.PORT ?? '3000'),
  process.env.HOST ?? '0.0.0.0',
);
