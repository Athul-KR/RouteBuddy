import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import { AppModule } from './app.module.js';

async function bootstrap() {
  mkdirSync('data', { recursive: true });
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Voice recordings arrive as raw audio (about 0.5 MB a minute); the default limit is far smaller.
  app.useBodyParser('raw', { type: ['audio/*', 'application/octet-stream'], limit: '4mb' });
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PORT ?? 3000);
  // 0.0.0.0 so a phone on the same Wi-Fi can reach the API.
  await app.listen(port, '0.0.0.0');
  console.log(`Everyday Buddy API on http://localhost:${port}/v1/health`);
}
await bootstrap();
