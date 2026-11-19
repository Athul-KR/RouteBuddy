import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { UserId } from '../common/auth.js';
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

  /** Text -> Buddy's voice, as MP3. Malayalam replies are read in Malayalam. */
  @Post('speak')
  @HttpCode(200)
  async speak(@UserId() userId: number, @Body() d: SpeakDto, @Res() out: Response) {
    const key = this.key();
    const text = speakable(d.text);
    if (!text) throw new BadRequestException('Nothing to read aloud.');
    this.count(userId, 'tts');
    const res = await fetch(`${API}/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
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
