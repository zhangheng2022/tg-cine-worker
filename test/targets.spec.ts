import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	decodeTarget,
	getTelegramPolicy,
	parseCidrs,
	policyAllows,
	resolveTarget,
	TELEGRAM_CIDR_SOURCE,
	TELEGRAM_POLICY_CACHE_KEY,
} from '../src/targets';

afterEach(() => vi.restoreAllMocks());
describe('Telegram official network policy', () => {
	it('accepts rotating IPv4 and IPv6 only inside the official ranges', async () => {
		expect(await resolveTarget('ip4_5b6c388b')).toEqual({ hostname: '91.108.56.139', port: 443 });
		expect(await resolveTarget('ip4_5b6c38a4')).toEqual({ hostname: '91.108.56.164', port: 443 });
		expect(await resolveTarget('ip6_20010b28f23f00000000000000000001')).toEqual({
			hostname: '2001:0b28:f23f:0000:0000:0000:0000:0001',
			port: 443,
		});
		for (const id of [
			'ip4_08080808',
			'ip4_7f000001',
			'ip4_0a000001',
			'ip6_00000000000000000000000000000001',
			'ip6_00000000000000000000ffff7f000001',
			'ip4_5b6c38a4_80',
			'dc5',
			'ip4_5B6C38A4',
		]) {
			expect(((await resolveTarget(id)) as Response).status).toBe(403);
		}
		expect(policyAllows('91.108.60.1', ['91.108.56.0/22'])).toBe(false);
		expect((decodeTarget('ip4_ffffffff') as Response).status).toBe(403);
	});
	it.each([
		'',
		'0.0.0.0/0',
		'127.0.0.0/8',
		'10.0.0.0/8',
		'91.108.56.0/33',
		'91.108.56.0/22\ninvalid',
		'::/0',
		'2001:b28:f23f::/129',
		'x'.repeat(16385),
	])('rejects invalid or oversized policy %s', (text) => {
		expect(() => parseCidrs(text)).toThrow();
	});
	it('fetches only the official source, validates then caches for one hour', async () => {
		await caches.default.delete(TELEGRAM_POLICY_CACHE_KEY);
		const source = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('91.108.56.0/22\n2001:b28:f23f::/48\n'));
		const first = await getTelegramPolicy();
		expect(first).not.toBeInstanceOf(Response);
		expect(source).toHaveBeenCalledWith(
			TELEGRAM_CIDR_SOURCE,
			expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }),
		);
		expect(await getTelegramPolicy()).toEqual(first);
		expect(source).toHaveBeenCalledTimes(1);
	});
	it('refreshes expired cache; malformed and failed responses fail closed', async () => {
		await caches.default.put(
			TELEGRAM_POLICY_CACHE_KEY,
			Response.json({ cidrs: ['91.108.56.0/22'], expiresAt: Date.now() - 1 }, { headers: { 'Cache-Control': 'public, max-age=3600' } }),
		);
		const source = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('127.0.0.0/8'));
		expect(((await getTelegramPolicy()) as Response).status).toBe(503);
		source.mockResolvedValue(new Response('bad', { status: 503 }));
		expect(((await getTelegramPolicy()) as Response).status).toBe(503);
		source.mockResolvedValue(new Response('x'.repeat(16385)));
		expect(((await getTelegramPolicy()) as Response).status).toBe(503);
	});
});
