import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsIn } from 'class-validator';
import { Repository } from 'typeorm';
import { UserId } from '../common/auth.js';
import { AppNotification } from '../common/entities.js';

class FeedbackDto {
  @IsIn(['up', 'down']) value: 'up' | 'down';
}

@Controller('v1/notifications')
export class NotificationsController {
  constructor(@InjectRepository(AppNotification) private notes: Repository<AppNotification>) {}

  @Get()
  list(@UserId() userId: number) {
    return this.notes.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    await this.notes.update({ id, userId }, { read: true });
  }

  @Post(':id/feedback')
  @HttpCode(204)
  async feedback(@UserId() userId: number, @Param('id', ParseIntPipe) id: number, @Body() d: FeedbackDto) {
    const r = await this.notes.update({ id, userId }, { feedback: d.value, read: true });
    if (!r.affected) throw new NotFoundException();
  }
}
