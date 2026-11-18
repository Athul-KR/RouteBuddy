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
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Repository } from 'typeorm';
import { UserId } from '../common/auth.js';
import { DEFAULT_SETTINGS, Reminder, SavedRoute, User, WaterLog } from '../common/entities.js';
import { localParts, TtlCache, today } from '../common/util.js';
import { PlacesProvider, RoutingProvider, WeatherProvider } from '../providers/providers.js';
import { Changed, chatTools } from './chat.tools.js';
import { forToday } from '../reminders/reminders.controller.js';
import { RouteStatusService } from '../routes/route-status.service.js';

class ChatMessageDto {
  @IsIn(['user', 'assistant']) role: 'user' | 'assistant';
  @IsString() @MinLength(1) @MaxLength(2000) content: string;
}

class ChatDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];
}

const MODEL = 'claude-opus-5-5';
/** Messages per user per hour, to keep the API bill predictable. */
const HOURLY_LIMIT = Number(process.env.CHAT_HOURLY_LIMIT ?? 30);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SYSTEM = `You are Buddy, the assistant inside Everyday Buddy, a daily companion app used mostly in Kerala, India.
The app tracks the user's saved commute routes (with live traffic, closures and a bypass when a road is blocked), reminders, water intake, weather and local news.

Each conversation includes a snapshot of the user's data at the moment of the question. Use it to answer questions about their routes, today's plan, water intake and weather. Quote times and numbers from the snapshot rather than estimating. If something isn't in the snapshot, say so plainly instead of guessing, and point to the part of the app that has it (Routes, Reminders, Explore).

You can also answer everyday questions on any topic.

You can make three changes for the user with your tools: log water (log_water), add a reminder to their schedule (add_reminder), and save a regular route (add_route). Use them when the user asks, or clearly says they did something, like "I just drank two glasses". Don't make changes they didn't ask for.
- For a reminder, a title and a time are enough. If no day is given, use today; if that time has already passed today, ask whether they meant tomorrow.
- For a route you need where they start, where they go, and when they leave. If any is missing or vague ("home", "office"), ask for the area or a landmark first. After saving, say which places were matched so they can check.
- After a change, confirm it in one short sentence using the tool's result. If a tool returns an error, explain it simply and ask for what's missing.
You can't delete or edit things; for that, point them to Routes or Reminders.

Write for a phone screen: short, friendly answers, a few sentences or a short list. The app shows plain text, so don't use markdown: no ** for bold, no # headings, no tables. For a list, start each line with "- ". Reply in the language the user writes in; if they write in Malayalam, reply in Malayalam.`;

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
  private async snapshot(user: User): Promise<string> {
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

    const glasses = await this.water.countBy({ userId, date: d });
    lines.push(settings.waterOn ? `Water today: ${glasses} of ${settings.waterGoal} glasses.` : 'Water tracking: turned off.');

    const w = await this.weather.forecast(user.lat, user.lon).catch(() => null);
    if (w) {
      const t = w.daily[0];
      let line = `Weather in ${user.city}: ${w.now.temp}°C now, ${w.now.symbol.replace(/_/g, ' ')}, humidity ${w.now.humidity}%.`;
      if (t) line += ` Today ${t.min}-${t.max}°C, rain ${t.rainMm} mm.`;
      if (w.rainSoon) line += ` Rain expected ${w.rainSoon.from}-${w.rainSoon.to}.`;
      lines.push(line);
    }
    return lines.join('\n');
  }

  @Post()
  @HttpCode(200)
  async chat(@UserId() userId: number, @Body() dto: ChatDto): Promise<{ reply: string; changed: Changed[] }> {
    if (!this.client) throw new ServiceUnavailableException('The assistant is not set up on this server yet.');

    // The conversation must start and end with the user; keep the last 20 turns.
    const history = dto.messages.slice(-20);
    while (history.length && history[0].role !== 'user') history.shift();
    if (!history.length || history[history.length - 1].role !== 'user') throw new HttpException('The last message must be from you.', HttpStatus.BAD_REQUEST);

    const hourKey = `${userId}:${new Date().toISOString().slice(0, 13)}`;
    const used = this.usage.get(hourKey) ?? 0;
    if (used >= HOURLY_LIMIT) throw new HttpException('You have sent a lot of messages this hour. Try again a little later.', HttpStatus.TOO_MANY_REQUESTS);
    this.usage.set(hourKey, used + 1, 60 * 60 * 1000);

    const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
    // Fresh data for this question, as an operator message right after it.
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException();
    messages.push({ role: 'system', content: `Snapshot of the user's data:\n${await this.snapshot(user)}` });

    const changed = new Set<Changed>();
    const tools = chatTools({ user, water: this.water, reminders: this.reminders, routes: this.routes, places: this.places, routing: this.routing }, changed);
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
