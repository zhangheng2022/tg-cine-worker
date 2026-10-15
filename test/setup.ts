import { beforeEach } from 'vitest';
import { TELEGRAM_POLICY_CACHE_KEY } from '../src/targets';

beforeEach(async () => {
	const updatedAt = Date.now();
	await caches.default.put(
		TELEGRAM_POLICY_CACHE_KEY,
		Response.json(
			{
				kind: 'telegram-cidr',
				port: 443,
				cidrs: ['91.108.56.0/22', '149.154.160.0/20', '2001:b28:f23f::/48'],
				updatedAt,
				expiresAt: updatedAt + 3600000,
			},
			{ headers: { 'Cache-Control': 'public, max-age=3600' } },
		),
	);
});
