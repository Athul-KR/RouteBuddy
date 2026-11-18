import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // SQLite file for the demo. Switch to { type: 'postgres', url: process.env.DATABASE_URL } for production.
    TypeOrmModule.forRoot({
      type: 'sqljs',
      location: process.env.DB_FILE ?? 'data/buddy.sqlite',
      autoSave: true,
      synchronize: true,
      entities: ENTITIES,
    }),
    TypeOrmModule.forFeature(ENTITIES),
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({ secret: process.env.JWT_SECRET ?? 'dev-only-change-me' }),
    }),
  ],
  controllers: [AuthController, MeController, RoutesController, RemindersController, NotificationsController, InfoController, ChatController],
  providers: [...PROVIDERS, RouteStatusService, AlertsJob, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
