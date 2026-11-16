import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdirSync } from 'node:fs';
import { AppModule } from './app.module.js';

async function bootstrap() {
  mkdirSync('data', { recursive: true });
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PORT ?? 3000);
  // 0.0.0.0 so a phone on the same Wi-Fi can reach the API.
  await app.listen(port, '0.0.0.0');
  console.log(`Everyday Buddy API on http://localhost:${port}/v1/health`);
}
await bootstrap();
