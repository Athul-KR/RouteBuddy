import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Repository } from 'typeorm';
import { UserId } from '../common/auth.js';
import { SavedRoute, type Vehicle } from '../common/entities.js';
import { defined } from '../common/util.js';
import { RoutingProvider } from '../providers/providers.js';
import { RouteStatusService } from './route-status.service.js';

const VEH = ['car', 'bike2', 'cycle', 'walk'];

class CreateRouteDto {
  @IsOptional() @IsString() name?: string;
  @IsString() fromName: string;
  @IsNumber() fromLat: number;
  @IsNumber() fromLon: number;
  @IsString() toName: string;
  @IsNumber() toLat: number;
  @IsNumber() toLon: number;
  @IsOptional() @IsIn(VEH) vehicle?: Vehicle;
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) days: number[];
  @Matches(/^\d{2}:\d{2}$/) departTime: string;
  @IsOptional() @IsInt() @Min(1) @Max(120) thresholdMin?: number;
}

class UpdateRouteDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(VEH) vehicle?: Vehicle;
  @IsOptional() @IsInt() @Min(1) @Max(120) thresholdMin?: number;
}

class ScheduleDto {
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) days: number[];
  @Matches(/^\d{2}:\d{2}$/) departTime: string;
}

class PreviewDto {
  @IsNumber() fromLat: number;
  @IsNumber() fromLon: number;
  @IsNumber() toLat: number;
  @IsNumber() toLon: number;
  @IsOptional() @IsIn(VEH) vehicle?: Vehicle;
}

@Controller('v1/routes')
export class RoutesController {
  constructor(
    @InjectRepository(SavedRoute) private routes: Repository<SavedRoute>,
    private routing: RoutingProvider,
    private statusSvc: RouteStatusService,
  ) {}

  private async own(userId: number, id: number) {
    const r = await this.routes.findOneBy({ id, userId });
    if (!r) throw new NotFoundException('Route not found');
    return r;
  }

  @Get()
  async list(@UserId() userId: number) {
    const list = await this.routes.find({ where: { userId }, order: { departTime: 'ASC' } });
    return Promise.all(list.map(async (r) => ({ ...r, status: await this.statusSvc.status(r) })));
  }

  /** Path and time for a draft route, before saving. */
  @Post('preview')
  @HttpCode(200)
  preview(@Body() d: PreviewDto) {
    return this.routing.route([d.fromLon, d.fromLat], [d.toLon, d.toLat], d.vehicle ?? 'car');
  }

  @Post()
  async create(@UserId() userId: number, @Body() d: CreateRouteDto) {
    const vehicle = d.vehicle ?? 'car';
    const path = await this.routing.route([d.fromLon, d.fromLat], [d.toLon, d.toLat], vehicle);
    const r = await this.routes.save(
      this.routes.create({
        ...d, userId, vehicle, name: d.name || `${d.fromName} → ${d.toName}`, thresholdMin: d.thresholdMin ?? 10,
        geometry: path.geometry, usualMin: path.minutes, distanceKm: path.distanceKm,
      }),
    );
    return { ...r, status: await this.statusSvc.status(r) };
  }

  @Get(':id')
  async one(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    const r = await this.own(userId, id);
    return { ...r, status: await this.statusSvc.status(r) };
  }

  @Patch(':id')
  async update(@UserId() userId: number, @Param('id', ParseIntPipe) id: number, @Body() d: UpdateRouteDto) {
    const r = await this.own(userId, id);
    if (d.vehicle && d.vehicle !== r.vehicle) {
      const path = await this.routing.route([r.fromLon, r.fromLat], [r.toLon, r.toLat], d.vehicle);
      Object.assign(r, { geometry: path.geometry, usualMin: path.minutes, distanceKm: path.distanceKm });
    }
    Object.assign(r, defined(d));
    const saved = await this.routes.save(r);
    return { ...saved, status: await this.statusSvc.status(saved, true) };
  }

  @Put(':id/schedule')
  async schedule(@UserId() userId: number, @Param('id', ParseIntPipe) id: number, @Body() d: ScheduleDto) {
    const r = await this.own(userId, id);
    Object.assign(r, defined(d));
    return this.routes.save(r);
  }

  @Get(':id/status')
  async status(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.statusSvc.status(await this.own(userId, id), true);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    await this.routes.remove(await this.own(userId, id));
  }
}
