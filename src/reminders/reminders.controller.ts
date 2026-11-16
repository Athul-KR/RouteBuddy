import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { Repository } from 'typeorm';
import { UserId } from '../common/auth.js';
import { Reminder, WaterLog } from '../common/entities.js';
import { defined, today } from '../common/util.js';

class CreateReminderDto {
  @IsString() @IsNotEmpty() title: string;
  @Matches(/^\d{2}:\d{2}$/) time: string;
  @IsOptional() @IsIn(['once', 'daily']) repeat?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}

class UpdateReminderDto {
  @IsOptional() @IsString() @IsNotEmpty() title?: string;
  @IsOptional() @Matches(/^\d{2}:\d{2}$/) time?: string;
  @IsOptional() @IsIn(['once', 'daily']) repeat?: string;
  @IsOptional() @IsBoolean() done?: boolean;
}

/** Reminders that apply today: daily ones plus one-offs dated today. */
export function forToday(list: Reminder[], d = today()) {
  return list
    .filter((r) => r.repeat === 'daily' || r.date === d)
    .map((r) => ({ ...r, done: r.doneOn === d }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

@Controller('v1')
export class RemindersController {
  constructor(
    @InjectRepository(Reminder) private reminders: Repository<Reminder>,
    @InjectRepository(WaterLog) private water: Repository<WaterLog>,
  ) {}

  private async own(userId: number, id: number) {
    const r = await this.reminders.findOneBy({ id, userId });
    if (!r) throw new NotFoundException('Reminder not found');
    return r;
  }

  /** All reminders, so the app can schedule local notifications after a reinstall. */
  @Get('reminders')
  async list(@UserId() userId: number) {
    const all = await this.reminders.find({ where: { userId }, order: { time: 'ASC' } });
    const d = today();
    return { today: forToday(all, d), all: all.map((r) => ({ ...r, done: r.doneOn === d })) };
  }

  @Post('reminders')
  create(@UserId() userId: number, @Body() d: CreateReminderDto) {
    const repeat = d.repeat ?? 'once';
    return this.reminders.save(this.reminders.create({ ...d, userId, repeat, date: repeat === 'once' ? (d.date ?? today()) : undefined }));
  }

  @Patch('reminders/:id')
  async update(@UserId() userId: number, @Param('id', ParseIntPipe) id: number, @Body() d: UpdateReminderDto) {
    const r = await this.own(userId, id);
    const { done, ...rest } = d;
    Object.assign(r, defined(rest));
    if (done !== undefined) r.doneOn = done ? today() : (null as unknown as string);
    const saved = await this.reminders.save(r);
    return { ...saved, done: saved.doneOn === today() };
  }

  /** Marks the reminder done for today. */
  @Post('reminders/:id/log')
  async log(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.update(userId, id, { done: true });
  }

  @Delete('reminders/:id')
  @HttpCode(204)
  async remove(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    await this.reminders.remove(await this.own(userId, id));
  }

  @Get('water-logs')
  async waterToday(@UserId() userId: number) {
    return { date: today(), count: await this.water.countBy({ userId, date: today() }) };
  }

  @Post('water-logs')
  async logWater(@UserId() userId: number) {
    await this.water.save(this.water.create({ userId, date: today() }));
    return this.waterToday(userId);
  }

  /** Undo the last glass logged today. */
  @Delete('water-logs/last')
  async undoWater(@UserId() userId: number) {
    const last = await this.water.findOne({ where: { userId, date: today() }, order: { id: 'DESC' } });
    if (last) await this.water.remove(last);
    return this.waterToday(userId);
  }
}
