import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Repository } from 'typeorm';
import { UserId } from '../common/auth.js';
import { SavedRoute, type Vehicle } from '../common/entities.js';
import { defined } from '../common/util.js';
import { ALONG_KINDS, AlongRouteProvider, type AlongKind, RoutingProvider } from '../providers/providers.js';
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
  /** The option the user picked in the preview. Without it, the server plans the route itself. */
  @IsOptional() @IsArray() @ArrayMinSize(2) @ArrayMaxSize(20000) geometry?: [number, number][];
  @IsOptional() @IsNumber() @Min(0) @Max(1440) usualMin?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(5000) distanceKm?: number;
}

/** A picked path must be [lon, lat] pairs that start and end near the chosen places (within ~1 km). */
function validPath(d: CreateRouteDto): [number, number][] | null {
  const g = d.geometry;
  if (!g) return null;
  const ok = g.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
  const near = (p: [number, number], lon: number, lat: number) => Math.abs(p[0] - lon) < 0.01 && Math.abs(p[1] - lat) < 0.01;
  if (!ok || !near(g[0], d.fromLon, d.fromLat) || !near(g[g.length - 1], d.toLon, d.toLat)) {
    throw new BadRequestException('The chosen route does not match the start and destination');
  }
  return g;
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

class SimulateDto {
  @IsBoolean() on: boolean;
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
    private along: AlongRouteProvider,
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

  /** Up to three route options for a draft route, fastest first, before saving. */
  @Post('preview')
  @HttpCode(200)
  async preview(@Body() d: PreviewDto) {
    return { options: await this.routing.options([d.fromLon, d.fromLat], [d.toLon, d.toLat], d.vehicle ?? 'car') };
  }

  @Post()
  async create(@UserId() userId: number, @Body() d: CreateRouteDto) {
    const vehicle = d.vehicle ?? 'car';
    const picked = validPath(d);
    const path = picked && d.usualMin !== undefined && d.distanceKm !== undefined
      ? { geometry: picked, minutes: Math.round(d.usualMin), distanceKm: d.distanceKm }
      : await this.routing.route([d.fromLon, d.fromLat], [d.toLon, d.toLat], vehicle);
    const r = await this.routes.save(
      this.routes.create({
        ...defined(d), userId, vehicle, name: d.name || `${d.fromName} → ${d.toName}`, thresholdMin: d.thresholdMin ?? 10,
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

  /** Test switch: fakes a closure on this route. 404 unless ALLOW_SIMULATION=true. */
  @Post(':id/simulate-closure')
  @HttpCode(200)
  async simulate(@UserId() userId: number, @Param('id', ParseIntPipe) id: number, @Body() d: SimulateDto) {
    if (!RouteStatusService.simulationAllowed) throw new NotFoundException();
    const r = await this.own(userId, id);
    this.statusSvc.simulateClosure(r.id, d.on);
    return this.statusSvc.status(r, true);
  }

  /** Petrol pumps, food, hotels, ATMs or EV chargers along the route you would drive now (the bypass, if there is one). */
  @Get(':id/places')
  async places(@UserId() userId: number, @Param('id', ParseIntPipe) id: number, @Query('kind') kind?: string) {
    if (!kind || !(kind in ALONG_KINDS)) throw new BadRequestException(`kind must be one of: ${Object.keys(ALONG_KINDS).join(', ')}`);
    const r = await this.own(userId, id);
    const st = await this.statusSvc.status(r);
    const geometry = st.bypass?.geometry ?? r.geometry;
    const places = await this.along.search(`${r.id}:${st.bypass ? 'bypass' : 'route'}:${r.vehicle}`, geometry, kind as AlongKind);
    return { kind, onBypass: !!st.bypass, places };
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
