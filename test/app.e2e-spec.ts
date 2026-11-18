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

  it('saves the route option the user picked, and rejects one that does not match the places', async () => {
    const base = { fromName: 'A', fromLat: 8.5466, fromLon: 76.9426, toName: 'B', toLat: 8.5052, toLon: 76.96, days: [1], departTime: '08:30' };
    const picked = [[76.9426, 8.5466], [76.95, 8.53], [76.96, 8.5052]];
    const r = await request(app.getHttpServer()).post('/v1/routes').set(auth())
      .send({ ...base, geometry: picked, usualMin: 18, distanceKm: 7.4 }).expect(201);
    expect(r.body).toMatchObject({ geometry: picked, usualMin: 18, distanceKm: 7.4 });
    await request(app.getHttpServer()).post('/v1/routes').set(auth())
      .send({ ...base, geometry: [[70, 10], [71, 11]], usualMin: 5, distanceKm: 1 }).expect(400);
    await request(app.getHttpServer()).get(`/v1/routes/${r.body.id}/places?kind=casino`).set(auth()).expect(400);
    await request(app.getHttpServer()).get(`/v1/routes/999999/places?kind=petrol`).set(auth()).expect(404);
    await request(app.getHttpServer()).delete(`/v1/routes/${r.body.id}`).set(auth()).expect(204);
  });

  it('chat validates input and says when the assistant is not set up', async () => {
    await request(app.getHttpServer()).post('/v1/chat').set(auth()).send({ messages: [] }).expect(400);
    await request(app.getHttpServer()).post('/v1/chat').set(auth()).send({ messages: [{ role: 'system', content: 'hi' }] }).expect(400);
    await request(app.getHttpServer()).post('/v1/chat').send({ messages: [{ role: 'user', content: 'hi' }] }).expect(401);
    if (!process.env.ANTHROPIC_API_KEY) {
      await request(app.getHttpServer()).post('/v1/chat').set(auth()).send({ messages: [{ role: 'user', content: 'hi' }] }).expect(503);
    }
  });

  it('logs and undoes water', async () => {
    await request(app.getHttpServer()).post('/v1/water-logs').set(auth()).expect(201);
    const two = await request(app.getHttpServer()).post('/v1/water-logs').set(auth()).expect(201);
    expect(two.body.count).toBe(2);
    const undo = await request(app.getHttpServer()).delete('/v1/water-logs/last').set(auth()).expect(200);
    expect(undo.body.count).toBe(1);
    // Amounts in ml: a default glass is 250 ml, a bottle can be logged as 500.
    expect(undo.body.ml).toBe(250);
    const bottle = await request(app.getHttpServer()).post('/v1/water-logs').set(auth()).send({ ml: 500 }).expect(201);
    expect(bottle.body).toMatchObject({ ml: 750, count: 2, goalMl: 2500, last: { ml: 500 } });
    expect(bottle.body.history).toHaveLength(7);
    expect(bottle.body.history[6].ml).toBe(750);
    await request(app.getHttpServer()).post('/v1/water-logs').set(auth()).send({ ml: 5000 }).expect(400);
    await request(app.getHttpServer()).delete('/v1/water-logs/last').set(auth()).expect(200);
  });

  it('keeps a reminder\'s priority, note and notification switch', async () => {
    const r = await request(app.getHttpServer()).post('/v1/reminders').set(auth())
      .send({ title: 'Dentist', time: '10:00', priority: 'high', note: 'Bring the X-ray', notify: false }).expect(201);
    expect(r.body).toMatchObject({ priority: 'high', note: 'Bring the X-ray', notify: false });
    const plain = await request(app.getHttpServer()).post('/v1/reminders').set(auth()).send({ title: 'Call', time: '11:00' }).expect(201);
    expect(plain.body).toMatchObject({ priority: 'medium', notify: true });
    await request(app.getHttpServer()).post('/v1/reminders').set(auth()).send({ title: 'Bad', time: '11:00', priority: 'urgent' }).expect(400);
    const upd = await request(app.getHttpServer()).patch(`/v1/reminders/${r.body.id}`).set(auth()).send({ priority: 'low' }).expect(200);
    expect(upd.body).toMatchObject({ priority: 'low', note: 'Bring the X-ray', title: 'Dentist' });
    await request(app.getHttpServer()).delete(`/v1/reminders/${r.body.id}`).set(auth()).expect(204);
    await request(app.getHttpServer()).delete(`/v1/reminders/${plain.body.id}`).set(auth()).expect(204);
  });

  it('exports and deletes the account', async () => {
    const exp = await request(app.getHttpServer()).get('/v1/me/export').set(auth()).expect(200);
    expect(exp.body.waterLogs).toHaveLength(1);
    await request(app.getHttpServer()).delete('/v1/me').set(auth()).expect(204);
    await request(app.getHttpServer()).post('/v1/auth/login').send({ email: 'test@example.com', password: 'secret123' }).expect(401);
    // The deleted account's token is refused (401, so the app signs in again), not "Not Found".
    await request(app.getHttpServer()).get('/v1/dashboard').set(auth()).expect(401);
  });

  it('refuses a token for an account that no longer matches its id (database reset)', async () => {
    const reg = await request(app.getHttpServer())
      .post('/v1/auth/register').send({ name: 'New', email: 'new@example.com', password: 'secret123' }).expect(201);
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    const { sub } = jwt.decode(reg.body.accessToken) as { sub: number };
    // Same id, but issued for an account created at another time; old tokens without the claim too.
    const forged = await jwt.signAsync({ sub, typ: 'access', ca: 1 });
    const legacy = await jwt.signAsync({ sub, typ: 'access' });
    await request(app.getHttpServer()).get('/v1/dashboard').set({ authorization: `Bearer ${forged}` }).expect(401);
    await request(app.getHttpServer()).get('/v1/dashboard').set({ authorization: `Bearer ${legacy}` }).expect(401);
    await request(app.getHttpServer()).get('/v1/dashboard').set({ authorization: `Bearer ${reg.body.accessToken}` }).expect(200);
  });
});
