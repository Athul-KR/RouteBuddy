import Anthropic from '@anthropic-ai/sdk';
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Repository } from 'typeorm';
import { UserId } from '../common/auth.js';
import { DEFAULT_SETTINGS, Reminder, SavedRoute, User, WaterLog } from '../common/entities.js';
import { haversine, localParts, TtlCache, today } from '../common/util.js';
import { PlacesProvider, RoutingProvider, WeatherProvider } from '../providers/providers.js';
import { Changed, chatTools, type ToolDeps } from './chat.tools.js';
import { forToday } from '../reminders/reminders.controller.js';
import { RouteStatusService } from '../routes/route-status.service.js';
import { waterSummary } from '../reminders/water.js';

class ChatMessageDto {
  @IsIn(['user', 'assistant']) role: 'user' | 'assistant';
  @IsString() @MinLength(1) @MaxLength(2000) content: string;
}

/** Data that lives only on the phone, sent along so Buddy can answer about it. */
class DeviceDto {
  @IsOptional() @IsInt() @Min(0) @Max(200000) steps?: number;
  @IsOptional() @IsInt() @Min(0) @Max(200000) stepsGoal?: number;
  /** Where the phone is, when the user allows location. Used for this answer only, never stored. */
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lon?: number;
}

/** The day's spoken briefing: in the user's news language unless the app asks for another. */
class BriefingDto {
  @IsOptional() @IsIn(['en', 'ml']) lang?: 'en' | 'ml';
  @IsOptional() @ValidateNested() @Type(() => DeviceDto) device?: DeviceDto;
}

class ChatDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];
  @IsOptional() @ValidateNested() @Type(() => DeviceDto) device?: DeviceDto;
}

const MODEL = 'claude-opus-5-5';
/** Messages per user per hour, to keep the API bill predictable. */
const HOURLY_LIMIT = Number(process.env.CHAT_HOURLY_LIMIT ?? 30);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SYSTEM = `You are Buddy, the assistant inside Everyday Buddy, a daily companion app used mostly in Kerala, India.
The app tracks the user's saved commute routes (with live traffic, closures and a bypass when a road is blocked), reminders, water intake, weather and local news.

Each conversation includes a snapshot of the user's data at the moment of the question. Use it to answer questions about their routes, today's plan, water intake and weather. Quote times and numbers from the snapshot rather than estimating. If something isn't in the snapshot, say so plainly instead of guessing, and point to the part of the app that has it (Routes, Reminders, News, My Health).

You can also answer everyday questions on any topic.

The snapshot may include where the user is right now, from their phone. When they say "here", "from here", "near me" or "my location", use it: pass CURRENT_LOCATION as the place to your tools. If the snapshot has no current location, ask them to name the place instead of guessing. When they ask about the weather without naming a place, answer for where they are now if the snapshot has it.

To answer "how long to reach X" or "how far is X", use trip_time; it changes nothing.

You can make three changes for the user with your tools: log water (log_water), add a reminder to their schedule (add_reminder), and save a regular route (add_route). Use them when the user asks, or clearly says they did something, like "I just drank two glasses". Don't make changes they didn't ask for.
- For a reminder, a title and a time are enough. If no day is given, use today; if that time has already passed today, ask whether they meant tomorrow.
- For a route you need where they start, where they go, and when they leave. If any is missing or vague ("home", "office"), ask for the area or a landmark first. After saving, say which places were matched so they can check.
- After a change, confirm it in one short sentence using the tool's result. If a tool returns an error, explain it simply and ask for what's missing.
You can't delete or edit things; for that, point them to Routes or Reminders.

Write for a phone screen: short, friendly answers, a few sentences or a short list. The app shows plain text, so don't use markdown: no ** for bold, no # headings, no tables. For a list, start each line with "- ". Reply in the language the user writes in; if they write in Malayalam, reply in Malayalam.`;

const BRIEFING = `You are Buddy, the friendly assistant in Everyday Buddy, a daily companion app used mostly in Kerala, India.
Write the user's daily briefing from the snapshot of their data. It is shown in the chat and read aloud, the first time they open the app today.
- Greet them by first name for the time of day (morning, afternoon or evening; use the time in the snapshot). In Malayalam use a Malayalam greeting, such as സുപ്രഭാതം in the morning or നമസ്കാരം later, not English words in Malayalam letters.
- Today's weather where they are (their current location if the snapshot has it, otherwise their city): the temperature, and whether to expect rain and when.
- Their reminders still to come today, with times (skip ones marked done). If there are many, give the first few and say how many more. If none, say the day is free.
- Each saved route that runs today: how traffic looks right now, any delay or closure, and the time to leave by if the snapshot gives one. Skip routes that don't run today; if there are no routes, leave this out.
- End with a short, warm wish for the day.
Use only facts from the snapshot; don't invent numbers. Keep it under 90 words, in 3 to 5 short sentences of natural spoken language: no lists, no markdown, no emoji, and say times the way people speak them (8:30 am). Write only the briefing itself.`;

@Controller('v1/chat')
export class ChatController {
  private log = new Logger('Chat');
  // Pasted keys often pick up quotes, spaces or a line break; those make the API reject an otherwise good key.
  private apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim().replace(/^["']|["']$/g, '').trim();
  private client = this.apiKey ? new Anthropic({ apiKey: this.apiKey }) : null;
  private usage = new TtlCache<number>();

  constructor(
    private weather: WeatherProvider,
    private statusSvc: RouteStatusService,
    private places: PlacesProvider,
    private routing: RoutingProvider,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(SavedRoute) private routes: Repository<SavedRoute>,
    @InjectRepository(Reminder) private reminders: Repository<Reminder>,
    @InjectRepository(WaterLog) private water: Repository<WaterLog>,
  ) {}

  /** The user's data right now, as plain text for the model. Each part fails on its own. */
  /** The phone's location with a readable name, or undefined when the app didn't send one. */
  private async here(device?: DeviceDto): Promise<ToolDeps['here']> {
    if (device?.lat === undefined || device.lon === undefined) return undefined;
    const name = (await this.places.describe(device.lat, device.lon)) ?? `${device.lat.toFixed(4)}, ${device.lon.toFixed(4)}`;
    return { lat: device.lat, lon: device.lon, name };
  }

  private async snapshot(user: User, device?: DeviceDto, here?: ToolDeps['here']): Promise<string> {
    const userId = user.id;
    const settings = { ...DEFAULT_SETTINGS, ...user.settings };
    const now = localParts();
    const d = today();
    const hhmm = `${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`;
    const lines: string[] = [`Name: ${user.name}. City: ${user.city}. Now: ${DAYS[now.weekday]} ${d} ${hhmm} (India time).`];

    const myRoutes = await this.routes.findBy({ userId });
    if (!myRoutes.length) lines.push('Saved routes: none yet.');
    for (const r of myRoutes) {
      const days = r.days.length === 7 ? 'every day' : r.days.map((x) => DAYS[x]).join(', ') || 'no days set';
      let line = `Route "${r.name}": ${r.fromName} to ${r.toName}, ${r.distanceKm} km by ${r.vehicle}, usually ${Math.round(r.usualMin)} min, leaves ${r.departTime} on ${days}.`;
      const s = await this.statusSvc.status(r).catch(() => null);
      if (s) {
        line += ` Right now: ${s.message}`;
        if (s.leaveBy) line += ` Leave by ${s.leaveBy}.`;
        if (s.incidents.length) line += ` ${s.incidents.length} incident(s) on the way.`;
        if (s.bypass) line += ` Bypass available: ${s.bypass.minutes} min, ${s.bypass.distanceKm} km.`;
      }
      lines.push(line);
    }
    const next = this.statusSvc.nextTrip(myRoutes);
    if (next && Number.isFinite(next.inMin)) lines.push(`Next trip: "${next.route.name}" in ${next.inMin} min.`);

    const todays = forToday(await this.reminders.findBy({ userId }), d);
    lines.push(
      todays.length
        ? `Today's reminders: ${todays.map((r) => `${r.time} ${r.title}${r.done ? ' (done)' : ''}${r.repeat === 'daily' ? ' (daily)' : ''}`).join('; ')}.`
        : 'Today\'s reminders: none.',
    );

    const wt = await waterSummary(this.water, userId, settings.waterGoalMl);
    lines.push(settings.waterOn ? `Water today: ${wt.ml} ml of ${wt.goalMl} ml goal (${wt.count} drinks). Goal streak: ${wt.streak} day(s).` : 'Water tracking: turned off.');

    const w = await this.weather.forecast(user.lat, user.lon).catch(() => null);
    if (w) {
      const t = w.daily[0];
      let line = `Weather in ${user.city}: ${w.now.temp}°C now, ${w.now.symbol.replace(/_/g, ' ')}, humidity ${w.now.humidity}%.`;
      if (t) line += ` Today ${t.min}-${t.max}°C, rain ${t.rainMm} mm.`;
      if (w.rainSoon) line += ` Rain expected ${w.rainSoon.from}-${w.rainSoon.to}.`;
      lines.push(line);
    }
    if (here) {
      lines.push(`The user is now at: ${here.name} (from the phone's location).`);
      // Weather where they are, when that's away from their home city.
      if (haversine([here.lon, here.lat], [user.lon, user.lat]) > 15000) {
        const h = await this.weather.forecast(here.lat, here.lon).catch(() => null);
        if (h) {
          const t = h.daily[0];
          let line = `Weather where the user is now: ${h.now.temp}°C, ${h.now.symbol.replace(/_/g, ' ')}.`;
          if (t) line += ` Today ${t.min}-${t.max}°C, rain ${t.rainMm} mm.`;
          if (h.rainSoon) line += ` Rain expected ${h.rainSoon.from}-${h.rainSoon.to}.`;
          lines.push(line);
        }
      }
    } else {
      lines.push("Current location: not shared (the user hasn't allowed location, or it isn't available).");
    }
    if (device?.steps !== undefined) lines.push(`Steps today (from the phone): ${device.steps}${device.stepsGoal ? ` of ${device.stepsGoal} goal` : ''}.`);
    return lines.join('\n');
  }

  /** Counts a request against the user's hourly allowance. */
  private spend(userId: number) {
    const hourKey = `${userId}:${new Date().toISOString().slice(0, 13)}`;
    const used = this.usage.get(hourKey) ?? 0;
    if (used >= HOURLY_LIMIT) throw new HttpException('You have sent a lot of messages this hour. Try again a little later.', HttpStatus.TOO_MANY_REQUESTS);
    this.usage.set(hourKey, used + 1, 60 * 60 * 1000);
  }

  @Post('briefing')
  @HttpCode(200)
  async briefing(@UserId() userId: number, @Body() dto: BriefingDto): Promise<{ text: string; lang: 'en' | 'ml' }> {
    if (!this.client) throw new ServiceUnavailableException('The assistant is not set up on this server yet.');
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException();
    this.spend(userId);
    const lang = dto.lang ?? ({ ...DEFAULT_SETTINGS, ...user.settings }.newsLang === 'en' ? 'en' : 'ml');
    try {
      const response = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: BRIEFING,
        messages: [{
          role: 'user',
          content: `Snapshot of my data:
${await this.snapshot(user, dto.device, await this.here(dto.device))}

Write my briefing for today in ${lang === 'ml' ? 'Malayalam' : 'English'}.`,
        }],
      });
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      if (response.stop_reason === 'refusal' || !text) throw new ServiceUnavailableException("Buddy couldn't put today's briefing together.");
      return { text, lang };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.log.error(`Briefing failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException("Buddy couldn't put today's briefing together.");
    }
  }

  @Post()
  @HttpCode(200)
  async chat(@UserId() userId: number, @Body() dto: ChatDto): Promise<{ reply: string; changed: Changed[] }> {
    if (!this.client) throw new ServiceUnavailableException('The assistant is not set up on this server yet.');

    // The conversation must start and end with the user; keep the last 20 turns.
    const history = dto.messages.slice(-20);
    while (history.length && history[0].role !== 'user') history.shift();
    if (!history.length || history[history.length - 1].role !== 'user') throw new HttpException('The last message must be from you.', HttpStatus.BAD_REQUEST);

    this.spend(userId);

    const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
    // Fresh data for this question, as an operator message right after it.
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException();
    const here = await this.here(dto.device);
    messages.push({ role: 'system', content: `Snapshot of the user's data:\n${await this.snapshot(user, dto.device, here)}` });

    const changed = new Set<Changed>();
    const tools = chatTools({ user, water: this.water, reminders: this.reminders, routes: this.routes, places: this.places, routing: this.routing, here }, changed);
    const result = (reply: string) => ({ reply, changed: [...changed] });

    try {
      // The SDK's tool runner calls the tools Claude picks and feeds the results back until Claude answers.
      const response = await this.client.beta.messages.toolRunner({
        model: MODEL,
        tools,
        max_iterations: 6,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        // If the model declines on a safety classifier, the API retries on a fallback model in the same call.
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages,
      });
      if (response.stop_reason === 'refusal') return result("Sorry, I can't help with that one.");
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (response.stop_reason === 'max_tokens') this.log.warn('Reply hit max_tokens');
      return result(text || (changed.size ? 'Done.' : "Sorry, I couldn't come up with an answer. Try asking another way."));
    } catch (e) {
      // A change already made must still reach the app, so it refreshes.
      if (changed.size) {
        this.log.error(`Chat failed after a change: ${(e as Error).message}`);
        return result('Done, though I couldn\'t finish my reply. Check the app to see the change.');
      }
      if (e instanceof Anthropic.AuthenticationError) {
        // Log only the shape of the key, never the key itself.
        this.log.error(`ANTHROPIC_API_KEY was rejected (length ${this.apiKey.length}, starts with ${this.apiKey.slice(0, 7)}). Create a new key at console.anthropic.com.`);
        throw new ServiceUnavailableException('The assistant is not set up correctly on this server.');
      }
      if (e instanceof Anthropic.RateLimitError) throw new HttpException('The assistant is busy. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
      if (e instanceof Anthropic.APIError) {
        this.log.error(`Claude API error ${e.status}: ${e.message}`);
        throw new ServiceUnavailableException("The assistant couldn't answer right now. Try again in a moment.");
      }
      throw e;
    }
  }
}
