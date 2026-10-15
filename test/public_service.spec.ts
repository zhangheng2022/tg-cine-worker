import { env, createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { authenticatePublic, reservePublic, digest } from '../src/public_service';
import { MAX_SESSION_BYTES } from '../src/relay';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const configured: Env = {
	...env,
	PUBLIC_SERVICE_ENABLED: 'true',
	PUBLIC_SIGNING_KEY: 'a'.repeat(64),
	RELAY_ENABLED: 'true',
	RELAY_TOKEN: 'private-test-token',
};
function request(path: string, token?: string, body = '{}') {
	return new IncomingRequest(`https://worker.example${path}`, {
		method: path.startsWith('/v2/config') || path.startsWith('/v2/tunnel') ? 'GET' : 'POST',
		headers: {
			'Content-Type': 'application/json',
			'CF-Connecting-IP': `test-${crypto.randomUUID()}`,
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		...(path.startsWith('/v2/config') || path.startsWith('/v2/tunnel') ? {} : { body }),
	});
}
async function fetch(path: string, token?: string, body?: string) {
	return worker.fetch(request(path, token, body), configured, createExecutionContext());
}
async function enroll() {
	const response = await fetch('/v2/devices');
	expect(response.status).toBe(201);
	return response.json<{ accessToken: string; refreshToken: string; expiresAt: number }>();
}

describe('公共配置与独立设备凭据', () => {
	it('请求限流在注册和凭据存储之前返回可重试错误', async () => {
		const response = await worker.fetch(
			request('/v2/devices'),
			{ ...configured, PUBLIC_REQUESTS: { limit: async () => ({ success: false }) } },
			createExecutionContext(),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('60');
	});
	it('全球字节预算持久限制累计传输，未结算的预留不能被释放', async () => {
		const budget = env.PUBLIC_BUDGET.getByName(`quota-test-${crypto.randomUUID()}`);
		for (let index = 0; index < 64; index++) {
			const id = crypto.randomUUID();
			expect(await budget.reserve(id)).toBe(true);
			if (index < 63) await budget.settle(id, MAX_SESSION_BYTES);
		}
		expect(await budget.reserve(crypto.randomUUID())).toBe(false);
	});
	it('公开配置不包含凭据，关闭或密钥缺失时失败关闭', async () => {
		const response = await fetch('/v2/config');
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		const value = await response.text();
		const limits = JSON.parse(value).limits;
		expect(limits).not.toHaveProperty('enrollments');
		expect(limits).not.toHaveProperty('addressEnrollments');
		expect(value).toContain('wss://tg-cine.zhangheng.eu.org/v2/tunnel');
		expect(value).not.toContain('Token');
		expect(value).not.toContain(configured.PUBLIC_SIGNING_KEY);
		for (const overrides of [{ PUBLIC_SERVICE_ENABLED: 'false' }, { PUBLIC_SIGNING_KEY: '' }, { RELAY_ENABLED: 'false' }]) {
			expect((await worker.fetch(request('/v2/config'), { ...configured, ...overrides }, createExecutionContext())).status).toBe(503);
		}
	});
	it('独立签发、刷新后旧访问凭据失效，撤销同时拒绝访问和刷新', async () => {
		const first = await enroll();
		const other = await enroll();
		expect(first.accessToken).not.toBe(other.accessToken);
		expect(await authenticatePublic(request('/v2/tunnel', first.accessToken), configured)).not.toBeInstanceOf(Response);
		const refreshed = await fetch('/v2/devices/refresh', first.refreshToken);
		expect(refreshed.status).toBe(200);
		const next = await refreshed.json<{ accessToken: string }>();
		expect(await authenticatePublic(request('/v2/tunnel', first.accessToken), configured)).toBeInstanceOf(Response);
		expect(await authenticatePublic(request('/v2/tunnel', next.accessToken), configured)).not.toBeInstanceOf(Response);
		expect((await fetch('/v2/devices/revoke', first.refreshToken)).status).toBe(204);
		expect((await fetch('/v2/devices/refresh', first.refreshToken)).status).toBe(401);
		expect(await authenticatePublic(request('/v2/tunnel', next.accessToken), configured)).toBeInstanceOf(Response);
		expect(await authenticatePublic(request('/v2/tunnel', other.accessToken), configured)).not.toBeInstanceOf(Response);
	});
	it('共享开发令牌、篡改令牌和刷新令牌不能打开公共中转', async () => {
		const tokens = await enroll();
		for (const token of [configured.RELAY_TOKEN, tokens.refreshToken, `${tokens.accessToken.slice(0, -10)}0000000000`]) {
			expect((await fetch('/v2/tunnel?v=2&target=ip4_5b6c388b', token)).status).toBe(401);
		}
	});
	it('有界输入、方法与额外参数校验，注册不接收账号或消息数据', async () => {
		for (const body of ['[]', '{', '{"account":100}', `{"extra":"${'x'.repeat(1100)}"}`]) {
			expect((await fetch('/v2/devices', undefined, body)).status).toBe(400);
		}
		expect((await fetch('/v2/config?token=bad')).status).toBe(400);
		expect(
			(await worker.fetch(new IncomingRequest('https://worker.example/v2/devices'), configured, createExecutionContext())).status,
		).toBe(405);
	});
	it('激活不受每日次数限制，也不修改已有流量预算', async () => {
		const budget = env.PUBLIC_BUDGET.getByName('daily-budget');
		await runInDurableObject(budget, async (_instance, state) => {
			state.storage.sql.exec(
				'INSERT OR REPLACE INTO usage(day,bytes) VALUES (?,?)',
				Math.floor(Date.now() / 86_400_000),
				MAX_SESSION_BYTES,
			);
		});
		const ip = `test-${crypto.randomUUID()}`;
		for (let index = 0; index < 33; index++) {
			const req = request('/v2/devices');
			req.headers.set('CF-Connecting-IP', ip);
			expect((await worker.fetch(req, configured, createExecutionContext())).status).toBe(201);
		}
		await runInDurableObject(budget, async (_instance, state) => {
			expect(state.storage.sql.exec('SELECT bytes FROM usage WHERE day=?', Math.floor(Date.now() / 86_400_000)).one()).toEqual({
				bytes: MAX_SESSION_BYTES,
			});
		});
	});
	it('连接预留限制并发，关闭结算幂等，凭据从持久表读取', async () => {
		const tokens = await enroll();
		const access = await authenticatePublic(request('/v2/tunnel', tokens.accessToken), configured);
		if (access instanceof Response) throw new Error('Authentication failed');
		const closures: ((bytes: number) => Promise<void>)[] = [];
		for (let index = 0; index < 6; index++) {
			const close = await reservePublic(access, configured);
			if (close instanceof Response) throw new Error('Reservation failed');
			closures.push(close);
		}
		expect(((await reservePublic(access, configured)) as Response).status).toBe(429);
		for (const close of closures) {
			await close(0);
			await close(0);
		}
		await runInDurableObject(access.session, async (instance) => {
			expect(instance.authenticate(await digest(tokens.accessToken))).toBe(true);
		});
		const close = await reservePublic(access, configured);
		expect(close).not.toBeInstanceOf(Response);
		if (!(close instanceof Response)) await close(0);
	});
	it('设备日额度不能通过反复开关连接绕过，异常连接仍占额度', async () => {
		const tokens = await enroll();
		const access = await authenticatePublic(request('/v2/tunnel', tokens.accessToken), configured);
		if (access instanceof Response) throw new Error('Authentication failed');
		for (let index = 0; index < 16; index++) {
			const close = await reservePublic(access, configured);
			if (close instanceof Response) throw new Error('Reservation failed');
			await close(MAX_SESSION_BYTES);
		}
		expect(((await reservePublic(access, configured)) as Response).status).toBe(429);
	});
});
