import { it, expect } from 'vitest';
import { buildDashboard } from './server.js';
import { AppCore } from '../core/app-core.js';

it('rejects unauthenticated and cross-origin approval writes before domain mutation', async () => {
  const server = await buildDashboard(new AppCore());
  try {
    const path = '/api/repos/unknown/specs/T-1/approve';
    expect((await server.inject({ method: 'POST', url: path, payload: {} })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/api/review-session' })).statusCode).toBe(403);
    const session = await server.inject({ method: 'GET', url: '/api/review-session', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(session.headers['cache-control']).toBe('no-store');
    const result = await server.inject({ method: 'POST', url: path, headers: { origin: 'https://untrusted.example', 'x-specflow-review-session': session.json().token }, payload: {} });
    expect(result.statusCode).toBe(403);
  } finally { await server.close(); }
});
