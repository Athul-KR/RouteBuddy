import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppNotification, DEFAULT_SETTINGS, SavedRoute, User } from '../common/entities.js';
import { inQuietHours, localParts, toMinutes } from '../common/util.js';
import { WeatherProvider } from '../providers/providers.js';
import { RouteStatusService } from './route-status.service.js';

/**
 * Alert window scan, every 5 minutes. Each route is checked 45 and 15 minutes before departure.
 * The dedupe key makes the job idempotent: running it twice for one window writes one alert.
 * Alerts are stored as notifications the app polls; add Firebase push (plan M1) to send them to the phone.
 */
@Injectable()
export class AlertsJob {
  private log = new Logger('AlertsJob');
  private running = false;

  constructor(
    @InjectRepository(SavedRoute) private routes: Repository<SavedRoute>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(AppNotification) private notes: Repository<AppNotification>,
    private status: RouteStatusService,
    private weather: WeatherProvider,
  ) {}

  @Cron('0 */5 * * * *')
  async scan() {
    if (this.running) return;
    this.running = true;
    try {
      const now = localParts();
      const all = await this.routes.find();
      for (const r of all) {
        if (!r.days.includes(now.weekday)) continue;
        const until = toMinutes(r.departTime) - now.minutes;
        const window = until <= 50 && until > 40 ? 45 : until <= 20 && until > 10 ? 15 : null;
        if (window === null) continue;
        await this.check(r, window, now.date).catch((e) => this.log.warn(`Route ${r.id}: ${(e as Error).message}`));
      }
    } finally {
      this.running = false;
    }
  }

  private async check(r: SavedRoute, window: number, date: string) {
    const user = await this.users.findOneBy({ id: r.userId });
    if (!user) return;
    const s = { ...DEFAULT_SETTINGS, ...user.settings };
    if (s.alerts.quiet && inQuietHours(localParts().minutes, s.quietStart, s.quietEnd)) return;

    if (s.alerts.commute) {
      const st = await this.status.status(r, true);
      if (st.state === 'closed' || st.state === 'slow') {
        // The 15-minute recheck alerts again only if the state changed since the 45-minute alert.
        const earlier = await this.notes.findOneBy({ dedupeKey: `${r.id}:${date}:45:commute` });
        if (window === 45 || !earlier || !earlier.title.startsWith(st.state === 'closed' ? 'Road closed' : 'Slow')) {
          await this.save(user.id, r.id, `${r.id}:${date}:${window}:commute`, 'commute',
            st.state === 'closed' ? `Road closed on ${r.name}` : `Slow traffic on ${r.name}`, st.message);
        }
      }
    }

    if (s.alerts.weatherTrip && window === 45) {
      const w = await this.weather.forecast(r.fromLat, r.fromLon).catch(() => null);
      const soon = w?.hourly.slice(0, 3).some((h) => h.rainMm >= 0.3);
      if (soon) await this.save(user.id, r.id, `${r.id}:${date}:rain`, 'weather', 'Rain before your trip', `Take an umbrella or rain gear for ${r.name}.`);
    }
  }

  private async save(userId: number, routeId: number, dedupeKey: string, type: string, title: string, body: string) {
    if (await this.notes.existsBy({ dedupeKey })) return;
    await this.notes.save(this.notes.create({ userId, routeId, dedupeKey, type, title, body }));
    this.log.log(`Alert for user ${userId}: ${title}`);
  }
}
