import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Public, UserId } from '../common/auth.js';
import { TtlCache } from '../common/util.js';

const API = 'https://api.elevenlabs.io/v1';
/** Speech-to-text: Scribe v3 understands Malayalam and English, including both mixed in one sentence. */
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v3';
/** Text-to-speech: v4 Turbo lists Malayalam (multilingual v2, the API's default, does not) and answers quickly. */
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_v4_turbo';
/** The voice Buddy speaks with. Override with ELEVENLABS_VOICE_ID (any voice from the ElevenLabs library). */
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb';
/** Requests per user per hour, for each of listening and speaking, to keep the bill predictable. */
const HOURLY_LIMIT = Number(process.env.VOICE_HOURLY_LIMIT ?? 40);
/** Recordings longer than this aren't accepted (the app stops at 60 s). */
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;

class SpeakDto {
  @IsString() @MinLength(1) @MaxLength(4000) text: string;
  /** 'ml' or 'en'; worked out from the text when left out. */
  @IsOptional() @IsString() @MaxLength(5) lang?: string;
  /** The voice the user picked in Settings; the server's default when left out. */
  @IsOptional() @Matches(/^[A-Za-z0-9]{8,40}$/, { message: 'Unknown voice.' }) voice?: string;
}

/**
 * Audio being made for one reply, shared by every request for it: the chunks so far, and who is waiting for more.
 * The player may ask for the same link more than once (it probes, or reconnects), so it is made only once.
 */
class AudioJob {
  chunks: Buffer[] = [];
  done = false;
  failed = false;
  private waiting = new Set<() => void>();

  add(chunk: Buffer) {
    this.chunks.push(chunk);
    this.wake();
  }
  finish(failed = false) {
    this.done = true;
    this.failed = failed;
    this.wake();
  }
  private wake() {
    for (const w of this.waiting) w();
    this.waiting.clear();
  }
  /** Chunk [i] once it exists; undefined when the audio has ended. */
  async next(i: number): Promise<Buffer | undefined> {
    while (i >= this.chunks.length && !this.done) await new Promise<void>((r) => this.waiting.add(r));
    return this.chunks[i];
  }
}

/** What a stream link plays: kept for two minutes. */
interface Ticket { text: string; lang: 'ml' | 'en'; voice: string; job?: AudioJob }

/** A voice the user can pick, as the app shows it. */
export interface VoiceOption {
  id: string;
  name: string;
  /** For example "Female · American · Young". */
  about: string;
  /** What it suits, e.g. "Warm, friendly narration". */
  description: string;
}

/** ElevenLabs' voice list -> what the app shows, the server's default voice first, then by name. */
export function voiceOptions(
  list: { voice_id: string; name: string; category?: string; labels?: Record<string, string | undefined>; description?: string | null }[],
  defaultId: string,
): VoiceOption[] {
  const cap = (x?: string) => (x ? x.charAt(0).toUpperCase() + x.slice(1).replace(/[_-]/g, ' ') : '');
  return list
    .filter((v) => v.voice_id && v.name)
    .map((v) => {
      const l = v.labels ?? {};
      return {
        id: v.voice_id,
        // Library names often carry a tagline after a dash: "George - Warm, Captivating Storyteller".
        name: v.name.split(/\s+-\s+/)[0].trim(),
        about: [cap(l.gender), cap(l.accent), cap(l.age)].filter(Boolean).join(' · '),
        description: cap((l.description ?? l.descriptive ?? v.name.split(/\s+-\s+/)[1] ?? v.description ?? '').toString().trim().slice(0, 80)),
      };
    })
    .sort((a, b) => (a.id === defaultId ? -1 : b.id === defaultId ? 1 : a.name.localeCompare(b.name)));
}

/** Malayalam script anywhere in the text means Malayalam speech. */
export function speechLang(text: string, hint?: string): 'ml' | 'en' {
  if (hint === 'ml' || hint === 'en') return hint;
  return /[ഀ-ൿ]/.test(text) ? 'ml' : 'en';
}

/** Text as it should be read aloud: no markdown symbols or list dashes, at most ~1,500 characters. */
export function speakable(text: string): string {
  const t = text
    .replace(/[*_#`>]+/g, '')
    .replace(/^\s*-\s+/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
  if (t.length <= 1500) return t;
  const cut = t.slice(0, 1500);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('। '));
  return end > 600 ? cut.slice(0, end + 1) : cut;
}

/**
 * Voice for the chat: speech to text (what the user said) and text to speech (Buddy's reply), through ElevenLabs.
 * The API key stays here on the server; the app never sees it.
 */
@Controller('v1/voice')
export class VoiceController {
  private log = new Logger('Voice');
  private usage = new TtlCache<number>();
  private voices = new TtlCache<VoiceOption[]>();
  private tickets = new TtlCache<Ticket>();

  private key(): string {
    const k = (process.env.ELEVENLABS_API_KEY ?? '').trim().replace(/^["']|["']$/g, '').trim();
    if (!k) throw new ServiceUnavailableException('Voice is not set up on this server yet.');
    return k;
  }

  private count(userId: number, kind: string) {
    const k = `${kind}:${userId}:${new Date().toISOString().slice(0, 13)}`;
    const used = this.usage.get(k) ?? 0;
    if (used >= HOURLY_LIMIT) throw new HttpException('You have used voice a lot this hour. Try again a little later, or type instead.', HttpStatus.TOO_MANY_REQUESTS);
    this.usage.set(k, used + 1, 60 * 60 * 1000);
  }

  private async fail(res: globalThis.Response, what: string): Promise<never> {
    const body = await res.text().catch(() => '');
    this.log.error(`ElevenLabs ${what} failed: ${res.status} ${body.slice(0, 300)}`);
    if (res.status === 401) throw new ServiceUnavailableException('Voice is not set up correctly on this server.');
    if (res.status === 429) throw new HttpException('Voice is busy right now. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    throw new ServiceUnavailableException(`Couldn't ${what} right now. Try again in a moment.`);
  }

  /** The voices Buddy can speak with (for Settings), with the server's default first. */
  @Get('voices')
  async list(@UserId() _userId: number): Promise<{ default: string; voices: VoiceOption[] }> {
    const key = this.key();
    let voices = this.voices.get('all');
    if (!voices) {
      const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return this.fail(res, 'load the voices');
      const j = (await res.json()) as { voices?: Parameters<typeof voiceOptions>[0] };
      voices = voiceOptions(j.voices ?? [], VOICE_ID);
      this.voices.set('all', voices, 60 * 60 * 1000);
    }
    return { default: VOICE_ID, voices };
  }

  /** The recording (raw audio in the request body, e.g. audio/mp4) -> the words, and the language heard. */
  @Post('transcribe')
  @HttpCode(200)
  async transcribe(@UserId() userId: number, @Body() audio: unknown, @Headers('content-type') type?: string): Promise<{ text: string; lang: string }> {
    const key = this.key();
    if (!Buffer.isBuffer(audio) || audio.length < 1000) throw new BadRequestException('No recording received. Hold the mic a little longer.');
    if (audio.length > MAX_AUDIO_BYTES) throw new BadRequestException('That recording is too long. Keep it under a minute.');
    this.count(userId, 'stt');
    const form = new FormData();
    form.append('model_id', STT_MODEL);
    form.append('tag_audio_events', 'false');
    form.append('file', new Blob([new Uint8Array(audio)], { type: type || 'audio/mp4' }), 'voice.m4a');
    const res = await fetch(`${API}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return this.fail(res, 'understand that');
    const j = (await res.json()) as { text?: string; language_code?: string };
    const text = (j.text ?? '').trim();
    return { text, lang: (j.language_code ?? '').slice(0, 3) };
  }

  /**
   * Starts reading [text] aloud and returns a link the phone's player opens directly. The audio streams while
   * ElevenLabs makes it, so playback starts in about a second instead of after the whole reply is ready.
   * The link is unguessable and expires after two minutes; it needs no login, since a player can't send one.
   */
  @Post('prepare')
  @HttpCode(200)
  prepare(@UserId() userId: number, @Body() d: SpeakDto): { url: string } {
    this.key();
    const text = speakable(d.text);
    if (!text) throw new BadRequestException('Nothing to read aloud.');
    this.count(userId, 'tts');
    const id = randomBytes(18).toString('base64url');
    this.tickets.set(id, { text, lang: speechLang(text, d.lang), voice: d.voice ?? VOICE_ID }, 2 * 60 * 1000);
    return { url: `/v1/voice/stream/${id}.mp3` };
  }

  @Public()
  @Get('stream/:id')
  async stream(@Param('id') raw: string, @Res() out: Response) {
    const t = this.tickets.get(raw.replace(/\.mp3$/, ''));
    if (!t) throw new NotFoundException('This audio has expired.');
    if (!t.job) t.job = this.make(t);
    const job = t.job;
    out.setHeader('content-type', 'audio/mpeg');
    out.setHeader('cache-control', 'no-store');
    let gone = false;
    out.on('close', () => { gone = true; });
    for (let i = 0; !gone; i++) {
      const chunk = await job.next(i);
      if (!chunk) break;
      out.write(chunk);
    }
    if (job.failed && !out.headersSent) out.status(503);
    out.end();
  }

  /** Asks ElevenLabs for the audio and keeps the chunks as they arrive. */
  private make(t: Ticket): AudioJob {
    const job = new AudioJob();
    (async () => {
      try {
        const res = await fetch(`${API}/text-to-speech/${t.voice}/stream?output_format=mp3_44100_64`, {
          method: 'POST',
          headers: { 'xi-api-key': this.key(), 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text: t.text, model_id: TTS_MODEL, language_code: t.lang }),
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok || !res.body) {
          this.log.error(`ElevenLabs stream failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
          return job.finish(true);
        }
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) job.add(Buffer.from(chunk));
        job.finish();
      } catch (e) {
        this.log.error(`ElevenLabs stream failed: ${(e as Error).message}`);
        job.finish(true);
      }
    })();
    return job;
  }

  /** Text -> Buddy's voice, as MP3. Malayalam replies are read in Malayalam. */
  @Post('speak')
  @HttpCode(200)
  async speak(@UserId() userId: number, @Body() d: SpeakDto, @Res() out: Response) {
    const key = this.key();
    const text = speakable(d.text);
    if (!text) throw new BadRequestException('Nothing to read aloud.');
    this.count(userId, 'tts');
    const res = await fetch(`${API}/text-to-speech/${d.voice ?? VOICE_ID}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: TTS_MODEL, language_code: speechLang(text, d.lang) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return this.fail(res, 'read that aloud');
    const buf = Buffer.from(await res.arrayBuffer());
    out.setHeader('content-type', 'audio/mpeg');
    out.setHeader('cache-control', 'no-store');
    out.send(buf);
  }
}
