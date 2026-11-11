import { buildDashboard as build, type DashboardOptions } from '../dashboard/server.js';
import type { AppCore } from '../core/app-core.js';

/** Tests simulate a browser capability; production has no auth bypass option. */
export async function buildDashboard(app: AppCore, options?: DashboardOptions) {
  const server = await build(app, options);
  const inject = server.inject.bind(server);
  const response = await inject({ method: 'GET', url: '/api/review-session', headers: { 'sec-fetch-site': 'same-origin' } });
  const headers = { 'x-specflow-review-session': response.json().token };
  server.inject = ((input: any) => inject(typeof input === 'string' ? input : { ...input, headers: { ...headers, ...input.headers } })) as typeof server.inject;
  return server;
}
