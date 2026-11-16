import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Patch, Put } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { UserId } from '../common/auth.js';
import { defined } from '../common/util.js';
import { AppNotification, DEFAULT_SETTINGS, Reminder, SavedRoute, User, UserSettings, WaterLog } from '../common/entities.js';

class UpdateMeDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lon?: number;
}

export function publicUser(u: User) {
  const { passwordHash: _, ...rest } = u;
  return { ...rest, settings: { ...DEFAULT_SETTINGS, ...u.settings } };
}

@Controller('v1/me')
export class MeController {
  constructor(@InjectRepository(User) private users: Repository<User>, private db: DataSource) {}

  private async get(id: number) {
    const u = await this.users.findOneBy({ id });
    if (!u) throw new NotFoundException();
    return u;
  }

  @Get()
  async me(@UserId() id: number) {
    return publicUser(await this.get(id));
  }

  @Patch()
  async update(@UserId() id: number, @Body() dto: UpdateMeDto) {
    const u = await this.get(id);
    Object.assign(u, defined(dto));
    return publicUser(await this.users.save(u));
  }

  /** Accepts a partial settings object and merges it. */
  @Put('settings')
  async settings(@UserId() id: number, @Body() body: Partial<UserSettings>) {
    const u = await this.get(id);
    const allowed = Object.keys(DEFAULT_SETTINGS);
    const clean = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
    u.settings = { ...DEFAULT_SETTINGS, ...u.settings, ...clean };
    return publicUser(await this.users.save(u));
  }

  @Get('export')
  async export(@UserId() id: number) {
    return {
      user: publicUser(await this.get(id)),
      routes: await this.db.getRepository(SavedRoute).findBy({ userId: id }),
      reminders: await this.db.getRepository(Reminder).findBy({ userId: id }),
      waterLogs: await this.db.getRepository(WaterLog).findBy({ userId: id }),
      notifications: await this.db.getRepository(AppNotification).findBy({ userId: id }),
    };
  }

  /** Removes every row that belongs to the user. */
  @Delete()
  @HttpCode(204)
  async remove(@UserId() id: number) {
    await this.db.transaction(async (m) => {
      for (const E of [SavedRoute, Reminder, WaterLog, AppNotification]) await m.delete(E, { userId: id });
      await m.delete(User, { id });
    });
  }
}
