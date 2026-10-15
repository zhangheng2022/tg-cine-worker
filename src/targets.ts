import { BlockList, isIP } from 'node:net';
import { errorResponse } from './protocol';

export interface RelayTarget {
	hostname: string;
	port: number;
}
export const TELEGRAM_CIDR_SOURCE = 'https://core.telegram.org/resources/cidr.txt';
export const POLICY_TTL_MS = 60 * 60 * 1000;
export const TELEGRAM_POLICY_CACHE_KEY = 'https://tg-cine-policy.invalid/telegram-cidrs-v1';
export type TelegramPolicy = { kind: 'telegram-cidr'; port: 443; cidrs: string[]; updatedAt: number; expiresAt: number };

export function publicAddress(host: string): boolean {
	if (isIP(host) === 6) return /^[23][0-9a-f]{3}:/i.test(new URL(`http://[${host}]`).hostname.slice(1));
	if (isIP(host) !== 4) return false;
	const denied = new BlockList();
	for (const [network, prefix] of [
		['0.0.0.0', 8],
		['10.0.0.0', 8],
		['100.64.0.0', 10],
		['127.0.0.0', 8],
		['169.254.0.0', 16],
		['172.16.0.0', 12],
		['192.0.0.0', 24],
		['192.0.2.0', 24],
		['192.168.0.0', 16],
		['198.18.0.0', 15],
		['198.51.100.0', 24],
		['203.0.113.0', 24],
		['224.0.0.0', 3],
	] as const)
		denied.addSubnet(network, prefix);
	return !denied.check(host);
}

export function parseCidrs(text: string): string[] {
	if (text.length > 16384) throw new Error('Oversized Telegram policy');
	const cidrs = [...new Set(text.trim().split(/\s+/))];
	if (!cidrs.length || cidrs.length > 128) throw new Error('Invalid Telegram policy');
	for (const cidr of cidrs) {
		const match = /^([^/]+)\/(0|[1-9][0-9]{0,2})$/.exec(cidr);
		if (!match || !publicAddress(match[1])) throw new Error('Invalid Telegram network');
		const family = isIP(match[1]);
		const prefix = Number(match[2]);
		if (prefix < (family === 4 ? 8 : 16)) throw new Error('Overbroad Telegram network');
		new BlockList().addSubnet(match[1], prefix, family === 4 ? 'ipv4' : 'ipv6');
	}
	return cidrs;
}

export function policyAllows(host: string, cidrs: string[]): boolean {
	if (!publicAddress(host)) return false;
	const allowed = new BlockList();
	for (const cidr of cidrs) {
		const [network, prefix] = cidr.split('/');
		allowed.addSubnet(network, Number(prefix), isIP(network) === 4 ? 'ipv4' : 'ipv6');
	}
	return allowed.check(host, isIP(host) === 4 ? 'ipv4' : 'ipv6');
}

export async function getTelegramPolicy(): Promise<TelegramPolicy | Response> {
	let phase = 'cache_read';
	let sourceStatus: number | undefined;
	try {
		const cache = caches.default;
		const cached = await cache.match(TELEGRAM_POLICY_CACHE_KEY);
		if (cached) {
			const policy = await cached.json<TelegramPolicy>();
			if (policy.expiresAt > Date.now() && policy.expiresAt <= Date.now() + POLICY_TTL_MS) {
				parseCidrs(policy.cidrs.join('\n'));
				return policy;
			}
		}
		phase = 'source_fetch';
		const source = await fetch(TELEGRAM_CIDR_SOURCE, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
		sourceStatus = source.status;
		phase = 'source_read';
		if (source.status !== 200 || !source.body) throw new Error('Telegram policy unavailable');
		const reader = source.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > 16384) throw new Error('Oversized Telegram policy');
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		phase = 'source_parse';
		const cidrs = parseCidrs(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
		const updatedAt = Date.now();
		const policy: TelegramPolicy = { kind: 'telegram-cidr', port: 443, cidrs, updatedAt, expiresAt: updatedAt + POLICY_TTL_MS };
		phase = 'cache_write';
		await cache.put(TELEGRAM_POLICY_CACHE_KEY, Response.json(policy, { headers: { 'Cache-Control': 'public, max-age=3600' } }));
		return policy;
	} catch {
		console.warn(JSON.stringify({ event: 'telegram_policy_unavailable', phase, sourceStatus }));
		return errorResponse(503, 'TELEGRAM_POLICY_UNAVAILABLE', { 'Retry-After': '60' });
	}
}

export function decodeTarget(targetId: string): RelayTarget | Response {
	const match = /^ip([46])_([0-9a-f]+)$/.exec(targetId);
	if (!match || match[2].length !== (match[1] === '4' ? 8 : 32)) return errorResponse(403, 'TARGET_NOT_ALLOWED');
	const hostname =
		match[1] === '4'
			? match[2]
					.match(/../g)!
					.map((byte) => parseInt(byte, 16))
					.join('.')
			: match[2].match(/..../g)!.join(':');
	return publicAddress(hostname) ? { hostname, port: 443 } : errorResponse(403, 'TARGET_NOT_ALLOWED');
}

export async function resolveTarget(targetId: string): Promise<RelayTarget | Response> {
	const target = decodeTarget(targetId);
	if (target instanceof Response) return target;
	const policy = await getTelegramPolicy();
	if (policy instanceof Response) return policy;
	return policyAllows(target.hostname, policy.cidrs) ? target : errorResponse(403, 'TARGET_NOT_ALLOWED');
}
