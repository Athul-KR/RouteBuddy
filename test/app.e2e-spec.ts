import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';

// Use a throwaway database for tests.
process.env.DB_FILE = `data/test-${Date.now()}.sqlite`;
const { AppModule } = await import('./../src/app.module.js');

describe('Everyday Buddy API (e2e)', () => {
  let app: INestApplication<App>;
  let token = '';
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('health is public', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects requests without a token', () => request(app.getHttpServer()).get('/v1/dashboard').expect(401));

  it('validates sign-up input', () => request(app.getHttpServer()).post('/v1/auth/register').send({ email: 'bad', password: '1' }).expect(400));

  it('registers, logs in and refreshes', async () => {
    const reg = await request(app.getHttpServer())
      .post('/v1/auth/register').send({ name: 'Test', email: 'test@example.com', password: 'secret123' }).expect(201);
    expect(reg.body.accessToken).toBeTruthy();
    await request(app.getHttpServer()).post('/v1/auth/register').send({ name: 'Test', email: 'test@example.com', password: 'secret123' }).expect(409);
    await request(app.getHttpServer()).post('/v1/auth/login').send({ email: 'test@example.com', password: 'wrong-pass' }).expect(401);
    const login = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: 'TEST@example.com', password: 'secret123' }).expect(200);
    token = login.body.accessToken;
    const ref = await request(app.getHttpServer()).post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    expect(ref.body.accessToken).toBeTruthy();
    // An access token must not work as a refresh token.
    await request(app.getHttpServer()).post('/v1/auth/refresh').send({ refreshToken: token }).expect(401);
  });

  it('merges settings and ignores unknown keys', async () => {
    const res = await request(app.getHttpServer()).put('/v1/me/settings').set(auth()).send({ dark: true, hacker: 1 }).expect(200);
    expect(res.body.settings.dark).toBe(true);
    expect(res.body.settings.hacker).toBeUndefined();
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('creates, completes and deletes a reminder', async () => {
    const r = await request(app.getHttpServer()).post('/v1/reminders').set(auth()).send({ title: 'Call mom', time: '18:00' }).expect(201);
    let list = await request(app.getHttpServer()).get('/v1/reminders').set(auth()).expect(200);
    expect(list.body.today).toHaveLength(1);
    await request(app.getHttpServer()).post(`/v1/reminders/${r.body.id}/log`).set(auth()).expect(201);
    list = await request(app.getHttpServer()).get('/v1/reminders').set(auth()).expect(200);
    expect(list.body.today[0].done).toBe(true);
    await request(app.getHttpServer()).delete(`/v1/reminders/${r.body.id}`).set(auth()).expect(204);
    await request(app.getHttpServer()).post('/v1/reminders').set(auth()).send({ title: 'x', time: '25:99x' }).expect(400);
  });

  it('keeps fields a partial update leaves out', async () => {
    const r = await request(app.getHttpServer()).post('/v1/reminders').set(auth()).send({ title: 'Gym', time: '07:00', repeat: 'daily' }).expect(201);
    const u = await request(app.getHttpServer()).patch(`/v1/reminders/${r.body.id}`).set(auth()).send({ time: '07:30' }).expect(200);
    expect(u.body).toMatchObject({ title: 'Gym', time: '07:30', repeat: 'daily' });
    const me = await request(app.getHttpServer()).patch('/v1/me').set(auth()).send({ city: 'Kozhikode' }).expect(200);
    expect(me.body).toMatchObject({ name: 'Test', city: 'Kozhikode' });
    await request(app.getHttpServer()).delete(`/v1/reminders/${r.body.id}`).set(auth()).expect(204);
  });

  it('logs and undoes water', async () => {
    await request(app.getHttpServer()).post('/v1/water-logs').set(auth()).expect(201);
    const two = await request(app.getHttpServer()).post('/v1/water-logs').set(auth()).expect(201);
    expect(two.body.count).toBe(2);
    const undo = await request(app.getHttpServer()).delete('/v1/water-logs/last').set(auth()).expect(200);
    expect(undo.body.count).toBe(1);
  });

  it('exports and deletes the account', async () => {
    const exp = await request(app.getHttpServer()).get('/v1/me/export').set(auth()).expect(200);
    expect(exp.body.waterLogs).toHaveLength(1);
    await request(app.getHttpServer()).delete('/v1/me').set(auth()).expect(204);
    await request(app.getHttpServer()).post('/v1/auth/login').send({ email: 'test@example.com', password: 'secret123' }).expect(401);
  });
});
