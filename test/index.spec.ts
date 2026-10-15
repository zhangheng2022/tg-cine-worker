import { createExecutionContext, env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { TELEGRAM_POLICY_CACHE_KEY } from '../src/targets';
import worker from '../src/index';

const token = 'local-test-token';
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const configuredEnv: Env = {
	...env,
	RELAY_TOKEN: token,
	RELAY_ENABLED: 'true',
};

function tunnelRequest(
	query = 'v=2&target=ip4_5b6c388b',
	headers: Record<string, string> = {},
): Request<unknown, IncomingRequestCfProperties> {
	return new IncomingRequest(`https://worker.example/v2/tunnel?${query}`, {
		headers: { Authorization: `Bearer ${token}`, Upgrade: 'websocket', ...headers },
	});
}

describe('服务入口', () => {
	it('健康检查声明中转尚不可用，且不泄漏配置', async () => {
		const response = await SELF.fetch('https://worker.example/health');
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(await response.json()).toEqual({ service: 'tg-cine-worker', status: 'ok', protocolVersion: 2, capabilities: { tunnel: false } });
	});
	it('未配置密钥时健康检查仍可用，中转关闭', async () => {
		expect(
			(await worker.fetch(new IncomingRequest('https://worker.example/health'), { ...env, RELAY_TOKEN: '' }, createExecutionContext()))
				.status,
		).toBe(200);
		const response = await worker.fetch(tunnelRequest(), { ...configuredEnv, RELAY_TOKEN: '' }, createExecutionContext());
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: { code: 'AUTH_NOT_CONFIGURED' } });
	});
	it('未知路由返回 404', async () => {
		expect((await SELF.fetch('https://worker.example/unknown')).status).toBe(404);
	});
	it.each(['/v1/config', '/v1/devices', '/v1/devices/refresh', '/v1/devices/revoke', '/v1/tunnel'])(
		'v1 route %s is absent',
		async (path) => {
			for (const method of ['GET', 'POST']) {
				const response = await SELF.fetch(`https://worker.example${path}`, { method });
				expect(response.status).toBe(404);
				expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
			}
		},
	);
	it.each(['/health', '/v2/tunnel'])('限制 %s 的请求方法', async (path) => {
		const response = await SELF.fetch(`https://worker.example${path}`, { method: 'POST' });
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET');
	});
});

describe('中转请求边界', () => {
	it.each(['', 'Basic secret', 'Bearer wrong', 'Bearer x', `Bearer ${'x'.repeat(80)}`, 'Bearer local-test-token extra'])(
		'拒绝无效凭据 %j',
		async (authorization) => {
			const response = await worker.fetch(
				tunnelRequest(undefined, { Authorization: authorization }),
				configuredEnv,
				createExecutionContext(),
			);
			expect(response.status).toBe(401);
			expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
			expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED' } });
		},
	);
	it.each([
		'target=ip4_5b6c388b',
		'v=2',
		'v=2&v=2&target=ip4_5b6c388b',
		'v=2&target=ip4_5b6c388b&target=ip4_5b6c388b',
		'v=2&target=ip4_5b6c388b&token=secret',
		'v=2&target=ip4_5b6c388b&hostname=evil.example',
	])('拒绝歧义和额外查询参数 %s', async (query) => {
		const response = await worker.fetch(tunnelRequest(query), configuredEnv, createExecutionContext());
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: { code: 'INVALID_REQUEST' } });
	});
	it('拒绝不支持的协议', async () => {
		const response = await worker.fetch(tunnelRequest('v=0&target=ip4_5b6c388b'), configuredEnv, createExecutionContext());
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: { code: 'UNSUPPORTED_PROTOCOL' } });
	});
	it.each(['', 'https%3A%2F%2Fevil.example', '../dc2', 'x'.repeat(65)])('拒绝非法目标 ID %j', async (target) => {
		const response = await worker.fetch(tunnelRequest(`v=2&target=${target}`), configuredEnv, createExecutionContext());
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: { code: 'INVALID_TARGET' } });
	});
	it.each(['ip4_08080808', 'ip4_7f000001', 'ip6_00000000000000000000000000000001'])(
		'rejects destinations outside official ranges: %s',
		async (target) => {
			const response = await worker.fetch(tunnelRequest(`v=2&target=${target}`), configuredEnv, createExecutionContext());
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: { code: 'TARGET_NOT_ALLOWED' } });
		},
	);
	it('official policy unavailable rejects before opening the tunnel', async () => {
		await caches.default.delete(TELEGRAM_POLICY_CACHE_KEY);
		const source = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }));
		try {
			const response = await worker.fetch(tunnelRequest(), configuredEnv, createExecutionContext());
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: { code: 'TELEGRAM_POLICY_UNAVAILABLE' } });
		} finally {
			source.mockRestore();
		}
	});
	it('拒绝缺少 WebSocket 升级标头', async () => {
		const response = await worker.fetch(tunnelRequest(undefined, { Upgrade: '' }), configuredEnv, createExecutionContext());
		expect(response.status).toBe(426);
		expect(await response.json()).toEqual({ error: { code: 'WEBSOCKET_REQUIRED' } });
	});
	it('合法请求明确返回 501，不创建 WebSocket', async () => {
		const response = await worker.fetch(tunnelRequest(), { ...configuredEnv, RELAY_ENABLED: 'false' }, createExecutionContext());
		expect(response.status).toBe(501);
		expect(response.webSocket).toBeNull();
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(await response.json()).toEqual({ error: { code: 'TUNNEL_NOT_IMPLEMENTED' } });
	});
});
