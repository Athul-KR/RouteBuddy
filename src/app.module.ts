import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { AuthController } from './auth/auth.controller.js';
import { JwtAuthGuard } from './common/auth.js';
import { ENTITIES } from './common/entities.js';
import { InfoController } from './dashboard/info.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { PROVIDERS } from './providers/providers.js';
import { RemindersController } from './reminders/reminders.controller.js';
import { AlertsJob } from './routes/alerts.job.js';
import { RouteStatusService } from './routes/route-status.service.js';
import { RoutesController } from './routes/routes.controller.js';
import { MeController } from './users/me.controller.js';
import { ChatController } from './chat/chat.controller.js';
import { VoiceController } from './voice/voice.controller.js';

/**
 * Where data lives. With DATABASE_URL set (production) it's PostgreSQL, which survives deploys and restarts.
 * Without it, a local SQLite file, fine for development; on a host like Render that file is wiped on every deploy.
 * DATABASE_SSL: unset = TLS with certificate checks (Neon and most hosts); "no-verify" = TLS without checks;
 * "off" = no TLS (a database on the same machine).
 */
function databaseOptions(): TypeOrmModuleOptions {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const mode = process.env.DATABASE_SSL;
    return {
      type: 'postgres',
      url,
      ssl: mode === 'off' ? false : mode === 'no-verify' ? { rejectUnauthorized: false } : true,
      // Creates and updates tables from the entities. Fine at this stage; move to migrations before real users.
      synchronize: true,
      entities: ENTITIES,
    };
  }
  return { type: 'sqljs', location: process.env.DB_FILE ?? 'data/buddy.sqlite', autoSave: true, synchronize: true, entities: ENTITIES };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot(databaseOptions()),
    TypeOrmModule.forFeature(ENTITIES),
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({ secret: process.env.JWT_SECRET ?? 'dev-only-change-me' }),
    }),
  ],
  controllers: [AuthController, MeController, RoutesController, RemindersController, NotificationsController, InfoController, ChatController, VoiceController],
  providers: [...PROVIDERS, RouteStatusService, AlertsJob, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
