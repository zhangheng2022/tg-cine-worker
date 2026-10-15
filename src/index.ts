import { Hono } from 'hono';
import { errorResponse, PROTOCOL_VERSION } from './protocol';
import { handleTunnel } from './tunnel';
import { publicRoutes } from './public_service';
export { DeviceSession, ServiceBudget } from './public_access';

const app = new Hono<{ Bindings: Env }>();
app.onError(() => errorResponse(503, 'SERVICE_UNAVAILABLE'));
app.notFound(() => errorResponse(404, 'NOT_FOUND'));
app.get('/health', (c) =>
	c.json(
		{
			service: 'tg-cine-worker',
			status: 'ok',
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tunnel: c.env.RELAY_ENABLED === 'true' },
		},
		200,
		{ 'Cache-Control': 'no-store' },
	),
);
app.route('/v2', publicRoutes);
app.get('/v2/tunnel', (c) => handleTunnel(c.req.raw, c.env, c.executionCtx));
for (const [path, method] of [
	['/health', 'GET'],
	['/v2/config', 'GET'],
	['/v2/tunnel', 'GET'],
	['/v2/devices', 'POST'],
	['/v2/devices/refresh', 'POST'],
	['/v2/devices/revoke', 'POST'],
]) {
	app.all(path, () => errorResponse(405, 'METHOD_NOT_ALLOWED', { Allow: method }));
}
export default app;
