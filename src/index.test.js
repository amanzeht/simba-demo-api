const request = require('supertest');

describe('Simba demo API (no base path)', () => {
  const app = require('./index');

  test('GET / returns 200, a message, and environment', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBeDefined();
    expect(res.body.environment).toBeDefined();
  });

  test('GET /health returns healthy status', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  test('GET /version returns version info', async () => {
    const res = await request(app).get('/version');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('commit');
    expect(res.body).toHaveProperty('environment');
  });
});

describe('Simba demo API (BASE_PATH=/uat)', () => {
  let app;

  beforeAll(() => {
    process.env.BASE_PATH = '/uat';
    process.env.ENVIRONMENT = 'uat';
    jest.resetModules();
    app = require('./index');
  });

  afterAll(() => {
    delete process.env.BASE_PATH;
    delete process.env.ENVIRONMENT;
  });

  test('GET /uat returns the uat environment', async () => {
    const res = await request(app).get('/uat');
    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toBe('uat');
  });

  test('GET /uat/health is the UAT health check', async () => {
    const res = await request(app).get('/uat/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.environment).toBe('uat');
  });

  test('GET /uat/version is namespaced', async () => {
    const res = await request(app).get('/uat/version');
    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toBe('uat');
  });
});
