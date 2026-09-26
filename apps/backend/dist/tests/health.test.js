import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import healthRouter from '../src/routes/health.js';
describe('/health endpoint', () => {
    let app;
    beforeEach(() => {
        app = express();
        app.use('/health', healthRouter);
    });
    it('returns 200 with status, uptime, and version', async () => {
        process.env.BACKEND_VERSION = '1.2.3';
        const response = await request(app).get('/health');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            status: 'ok',
            uptime: expect.any(Number),
            version: '1.2.3',
        });
        expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    });
    it('returns 503 when deep health check fails', async () => {
        process.env.DEEP_HEALTH = 'true';
        process.env.STELLAR_RPC_URL = 'http://localhost:1';
        const response = await request(app).get('/health');
        expect(response.status).toBe(503);
        expect(response.body.status).toBe('error');
        expect(response.body.uptime).toBeGreaterThanOrEqual(0);
        expect(response.body.version).toBe('1.2.3');
    });
});
