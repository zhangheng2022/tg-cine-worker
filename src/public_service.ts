import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { errorResponse, PROTOCOL_VERSION } from './protocol';
import { getTelegramPolicy } from './targets';
import { DEVICE_DAILY_BYTES, GLOBAL_DAILY_BYTES, MAX_DEVICE_CONNECTIONS } from './public_access';
import type { DeviceSession } from './public_access';

const encoder = new TextEncoder();
const pattern = /^([ar])\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const encode = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
const decode = (value: string) =>
	Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), (letter) => letter.charCodeAt(0));

async function key(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function digest(value: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

async function mint(type: 'a' | 'r', id: string, secret: string): Promise<string> {
	const value = `${type}.${id}.${encode(crypto.getRandomValues(new Uint8Array(32)))}`;
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(value)));
	return `${value}.${encode(signature)}`;
}

async function readToken(request: Request, env: Env, type: 'a' | 'r'): Promise<{ id: string; hash: string } | null> {
	const token = /^Bearer ([^\s]{1,160})$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
	const match = token?.match(pattern);
	if (!token || !match || match[1] !== type) return null;
	const unsigned = token.slice(0, token.lastIndexOf('.'));
	if (!(await crypto.subtle.verify('HMAC', await key(env.PUBLIC_SIGNING_KEY), decode(match[4]), encoder.encode(unsigned)))) return null;
	return { id: match[2], hash: await digest(token) };
}

function unavailable(env: Env): Response | null {
	return env.PUBLIC_SERVICE_ENABLED !== 'true' || env.RELAY_ENABLED !== 'true' || !/^[a-f0-9]{64}$/.test(env.PUBLIC_SIGNING_KEY ?? '')
		? errorResponse(503, 'PUBLIC_SERVICE_UNAVAILABLE', { 'Retry-After': '60' })
		: null;
}

export type PublicAccess = { session: DurableObjectStub<DeviceSession>; hash: string };

async function rate(env: Env, key: string): Promise<Response | null> {
	return (await env.PUBLIC_REQUESTS.limit({ key })).success ? null : errorResponse(429, 'REQUEST_LIMIT', { 'Retry-After': '60' });
}

export async function authenticatePublic(request: Request, env: Env): Promise<PublicAccess | Response> {
	const disabled = unavailable(env);
	if (disabled) return disabled;
	const token = await readToken(request, env, 'a');
	if (!token) return errorResponse(401, 'UNAUTHORIZED', { 'WWW-Authenticate': 'Bearer' });
	const limited = await rate(env, `device:${token.id}`);
	if (limited) return limited;
	const session = env.PUBLIC_SESSIONS.getByName(token.id);
	if (!(await session.authenticate(token.hash))) return errorResponse(401, 'UNAUTHORIZED', { 'WWW-Authenticate': 'Bearer' });
	return { session, hash: token.hash };
}

export async function reservePublic(access: PublicAccess, env: Env): Promise<((bytes: number) => Promise<void>) | Response> {
	const id = crypto.randomUUID();
	const local = await access.session.reserve(access.hash, id);
	if (local === 'unauthorized') return errorResponse(401, 'UNAUTHORIZED');
	if (local === 'limited') return errorResponse(429, 'DEVICE_LIMIT', { 'Retry-After': '60' });
	const budget = env.PUBLIC_BUDGET.getByName('daily-budget');
	if (!(await budget.reserve(id))) {
		await access.session.settle(id, 0);
		return errorResponse(429, 'SERVICE_LIMIT', { 'Retry-After': '60' });
	}
	// Unsettled/expired reservations remain fully charged, including after process loss.
	return async (bytes) => {
		await Promise.all([access.session.settle(id, bytes), budget.settle(id, bytes)]);
	};
}

async function emptyBody(request: Request): Promise<boolean> {
	if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json' || !request.body) return false;
	const reader = request.body.getReader();
	let body = '';
	let size = 0;
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 1024) return false;
			body += decoder.decode(value, { stream: true });
		}
		body += decoder.decode();
		const value: unknown = JSON.parse(body);
		return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
	} catch {
		return false;
	} finally {
		await reader.cancel();
	}
}

type PublicEnv = { Bindings: Env; Variables: { refresh: { id: string; hash: string } } };
const available = createMiddleware<PublicEnv>(async (c, next) => {
	if (new URL(c.req.url).search) return errorResponse(400, 'INVALID_REQUEST');
	const disabled = unavailable(c.env);
	if (disabled) return disabled;
	c.header('Cache-Control', 'no-store');
	await next();
});
const bootstrap = createMiddleware<PublicEnv>(async (c, next) => {
	const ip = c.req.header('CF-Connecting-IP');
	if (!ip || ip.length > 64) return errorResponse(400, 'CLIENT_ADDRESS_REQUIRED');
	const limited = await rate(c.env, `bootstrap:${await digest(ip)}`);
	if (limited) return limited;
	await next();
});
const emptyJson = createMiddleware<PublicEnv>(async (c, next) => {
	if (!(await emptyBody(c.req.raw))) return errorResponse(400, 'INVALID_REQUEST');
	await next();
});
const refreshCredential = createMiddleware<PublicEnv>(async (c, next) => {
	const token = await readToken(c.req.raw, c.env, 'r');
	if (!token) return errorResponse(401, 'UNAUTHORIZED');
	const limited = await rate(c.env, `device:${token.id}`);
	if (limited) return limited;
	c.set('refresh', token);
	await next();
});

export const publicRoutes = new Hono<PublicEnv>()
	.get('/config', available, bootstrap, async (c) => {
		const origin = new URL(c.env.PUBLIC_ORIGIN);
		if (origin.protocol !== 'https:' || origin.origin !== c.env.PUBLIC_ORIGIN) return errorResponse(503, 'PUBLIC_SERVICE_UNAVAILABLE');
		const targetPolicy = await getTelegramPolicy();
		if (targetPolicy instanceof Response) return targetPolicy;
		return c.json({
			protocolVersion: PROTOCOL_VERSION,
			relay: `${c.env.PUBLIC_ORIGIN.replace('https:', 'wss:')}/v2/tunnel`,
			targetPolicy,
			limits: { deviceDailyBytes: DEVICE_DAILY_BYTES, serviceDailyBytes: GLOBAL_DAILY_BYTES, connections: MAX_DEVICE_CONNECTIONS },
		});
	})
	.post('/devices', available, bootstrap, emptyJson, async (c) => {
		const id = crypto.randomUUID();
		const refreshToken = await mint('r', id, c.env.PUBLIC_SIGNING_KEY);
		const accessToken = await mint('a', id, c.env.PUBLIC_SIGNING_KEY);
		const expiresAt = await c.env.PUBLIC_SESSIONS.getByName(id).enroll(await digest(refreshToken), await digest(accessToken));
		return c.json({ accessToken, refreshToken, expiresAt }, 201);
	})
	.post('/devices/refresh', available, emptyJson, refreshCredential, async (c) => {
		const token = c.get('refresh');
		const accessToken = await mint('a', token.id, c.env.PUBLIC_SIGNING_KEY);
		const expiresAt = await c.env.PUBLIC_SESSIONS.getByName(token.id).refresh(token.hash, await digest(accessToken));
		return expiresAt === null ? errorResponse(401, 'UNAUTHORIZED') : c.json({ accessToken, expiresAt });
	})
	.post('/devices/revoke', available, emptyJson, refreshCredential, async (c) => {
		const token = c.get('refresh');
		return (await c.env.PUBLIC_SESSIONS.getByName(token.id).revoke(token.hash)) ? c.body(null, 204) : errorResponse(401, 'UNAUTHORIZED');
	});
