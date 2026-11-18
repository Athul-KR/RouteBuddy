import { BadRequestException, Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public, UserId } from '../common/auth.js';
import { AppNotification, DEFAULT_SETTINGS, Reminder, SavedRoute, User, WaterLog } from '../common/entities.js';
import { today } from '../common/util.js';
import { NEWS_LANGS, NewsLang, NewsProvider, PlacesProvider, WeatherProvider } from '../providers/providers.js';
import { QuotaService } from '../providers/quota.service.js';
import { forToday } from '../reminders/reminders.controller.js';
import { RouteStatusService } from '../routes/route-status.service.js';

function coords(lat?: string, lon?: string): [number, number] {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) throw new BadRequestException('lat and lon are required');
  return [la, lo];
}

@Controller('v1')
export class InfoController {
  constructor(
    private weather: WeatherProvider,
    private news: NewsProvider,
    private places: PlacesProvider,
    private quota: QuotaService,
    private statusSvc: RouteStatusService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(SavedRoute) private routes: Repository<SavedRoute>,
    @InjectRepository(Reminder) private reminders: Repository<Reminder>,
    @InjectRepository(WaterLog) private water: Repository<WaterLog>,
    @InjectRepository(AppNotification) private notes: Repository<AppNotification>,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { ok: true, traffic: !!process.env.TOMTOM_KEY, simulation: RouteStatusService.simulationAllowed, quota: this.quota.report() };
  }

  @Get('weather')
  getWeather(@Query('lat') lat?: string, @Query('lon') lon?: string) {
    return this.weather.forecast(...coords(lat, lon));
  }

  /** News for the user's city, in the language given or their saved one. */
  @Get('news')
  async getNews(@UserId() userId: number, @Query('topic') topic?: string, @Query('lang') lang?: string) {
    const user = await this.users.findOneBy({ id: userId });
    const saved = { ...DEFAULT_SETTINGS, ...user?.settings }.newsLang;
    const l = NEWS_LANGS.includes(lang as NewsLang) ? (lang as NewsLang) : saved;
    return this.news.list(topic, l, user?.city);
  }

  @Get('places/search')
  search(@Query('q') q: string, @Query('lat') lat?: string, @Query('lon') lon?: string) {
    if (!q || q.trim().length < 2) return [];
    return this.places.search(q.trim(), ...coords(lat ?? '9.93', lon ?? '76.27'));
  }

  @Get('places/reverse')
  async reverse(@Query('lat') lat?: string, @Query('lon') lon?: string) {
    return { name: await this.places.reverse(...coords(lat, lon)) };
  }

  /** One call that assembles the home screen. Each part fails on its own, so one slow provider never blanks the page. */
  @Get('dashboard')
  async dashboard(@UserId() userId: number) {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException();
    const d = today();
    const myRoutes = await this.routes.findBy({ userId });
    const next = this.statusSvc.nextTrip(myRoutes);

    const [weather, headlines, status] = await Promise.all([
      this.weather.forecast(user.lat, user.lon).catch(() => null),
      this.news.list(undefined, { ...DEFAULT_SETTINGS, ...user.settings }.newsLang, user.city).then((n) => n.slice(0, 3)).catch(() => []),
      next ? this.statusSvc.status(next.route).catch(() => null) : Promise.resolve(null),
    ]);

    const settings = { ...DEFAULT_SETTINGS, ...user.settings };
    return {
      name: user.name,
      city: user.city,
      settings,
      weather,
      commute: next && status ? { route: { ...next.route, geometry: next.route.geometry }, inMin: Number.isFinite(next.inMin) ? next.inMin : null, status } : null,
      headlines,
      reminders: forToday(await this.reminders.findBy({ userId }), d),
      water: { count: await this.water.countBy({ userId, date: d }), goal: settings.waterGoal },
      unread: await this.notes.countBy({ userId, read: false }),
    };
  }
}
