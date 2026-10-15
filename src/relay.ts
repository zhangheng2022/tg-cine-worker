import { connect } from 'cloudflare:sockets';
import { errorResponse } from './protocol';
import type { RelayTarget } from './targets';

export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_PENDING_BYTES = 256 * 1024;
export const MAX_PENDING_FRAMES = 64;
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const SESSION_MS = 15 * 60 * 1000;
const IDLE_MS = 30_000;
const CONNECT_MS = 5_000;
const ACK_MS = 30_000;

export type RelaySocket = Pick<Socket, 'readable' | 'writable' | 'opened' | 'closed' | 'close'>;
export type ConnectRelay = (target: RelayTarget) => RelaySocket;

export async function openRelay(
	target: RelayTarget,
	ctx: Pick<ExecutionContext, 'waitUntil'>,
	connectRelay: ConnectRelay = connect,
	traceId?: string,
	onClose?: (bytes: number) => Promise<void>,
): Promise<Response> {
	let socket: RelaySocket | undefined;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		socket = connectRelay(target);
		void socket.closed.catch(() => {});
		await Promise.race([
			socket.opened,
			new Promise<never>((_, reject) => {
				connectTimer = setTimeout(() => reject(new Error('timeout')), CONNECT_MS);
			}),
		]);
	} catch {
		// No destination, token, or upstream exception is returned to the caller.
		if (socket) ctx.waitUntil(socket.close().catch(() => {}));
		if (onClose) ctx.waitUntil(onClose(0));
		return errorResponse(502, 'UPSTREAM_UNAVAILABLE');
	} finally {
		if (connectTimer !== undefined) clearTimeout(connectTimer);
	}
	const connectedSocket = socket;

	const { 0: client, 1: server } = new WebSocketPair();
	server.binaryType = 'arraybuffer';
	server.accept({ allowHalfOpen: true });
	const reader = connectedSocket.readable.getReader();
	const writer = connectedSocket.writable.getWriter();
	let stopped = false;
	let pendingBytes = 0;
	let sessionBytes = 0;
	let pendingWrites = Promise.resolve();
	const pendingFrames: { bytes: number; sentAt: number }[] = [];
	let inFlightBytes = 0;
	const startedAt = Date.now();
	let ackWaitMs = 0;
	let upstreamReadMs = 0;
	let downFrames = 0;
	let downBytes = 0;
	let maxInFlightBytes = 0;
	let maxAckAgeMs = 0;
	let windowReady: (() => void) | undefined;
	let ackTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout>;
	const sessionTimer = setTimeout(() => stop(1008, 'SESSION_LIMIT'), SESSION_MS);

	function stop(code = 1000, reason = 'CLOSED') {
		if (stopped) return;
		stopped = true;
		if (pendingFrames.length) maxAckAgeMs = Math.max(maxAckAgeMs, Date.now() - pendingFrames[0].sentAt);
		clearTimeout(idleTimer);
		clearTimeout(sessionTimer);
		if (ackTimer !== undefined) clearTimeout(ackTimer);
		windowReady?.();
		windowReady = undefined;
		pendingFrames.length = 0;
		inFlightBytes = 0;
		if (onClose) ctx.waitUntil(onClose(Math.min(sessionBytes, MAX_SESSION_BYTES)));
		if (server.readyState < WebSocket.CLOSED) server.close(code, reason);
		ctx.waitUntil(
			Promise.allSettled([reader.cancel(), writer.abort(), connectedSocket.close()]).then(() => {
				console.log(
					JSON.stringify({
						event: 'relay_closed',
						traceId: traceId && /^[a-zA-Z0-9_-]{32}$/.test(traceId) ? traceId : 'untracked',
						code,
						reason,
						elapsedMs: Date.now() - startedAt,
						sessionBytes,
						ackWaitMs,
						upstreamReadMs,
						downFrames,
						downBytes,
						maxInFlightBytes,
						maxAckAgeMs,
					}),
				);
			}),
		);
	}

	function touch() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => stop(1008, 'IDLE_TIMEOUT'), IDLE_MS);
	}

	function armAcknowledgementTimeout() {
		if (ackTimer !== undefined) clearTimeout(ackTimer);
		if (pendingFrames.length) {
			ackTimer = setTimeout(() => stop(1008, 'ACK_TIMEOUT'), Math.max(0, pendingFrames[0].sentAt + ACK_MS - Date.now()));
		}
	}

	function waitForAcknowledgement(): Promise<void> {
		const waitingAt = Date.now();
		return new Promise((resolve) => {
			windowReady = () => {
				ackWaitMs += Date.now() - waitingAt;
				resolve();
			};
		});
	}

	function count(bytes: number): boolean {
		sessionBytes += bytes;
		if (sessionBytes > MAX_SESSION_BYTES) {
			stop(1008, 'BYTE_LIMIT');
			return false;
		}
		return true;
	}

	server.addEventListener('close', () => stop());
	server.addEventListener('error', () => stop(1011, 'TRANSPORT_ERROR'));
	server.addEventListener('message', (event) => {
		if (stopped) return;
		if (event.data === 'ACK' && pendingFrames.length) {
			const acknowledged = pendingFrames.shift()!;
			maxAckAgeMs = Math.max(maxAckAgeMs, Date.now() - acknowledged.sentAt);
			inFlightBytes -= acknowledged.bytes;
			armAcknowledgementTimeout();
			windowReady?.();
			windowReady = undefined;
			touch();
			return;
		}
		if (!(event.data instanceof ArrayBuffer)) {
			stop(1003, 'BINARY_REQUIRED');
			return;
		}
		const data = new Uint8Array(event.data);
		if (!data.byteLength || data.byteLength > MAX_FRAME_BYTES || pendingBytes + data.byteLength > MAX_PENDING_BYTES) {
			stop(1009, 'FRAME_OR_QUEUE_LIMIT');
			return;
		}
		if (!count(data.byteLength)) return;
		pendingBytes += data.byteLength;
		touch();
		pendingWrites = pendingWrites
			.then(async () => {
				try {
					if (stopped) return;
					await writer.write(data);
					if (!stopped) server.send('ACK');
				} finally {
					pendingBytes -= data.byteLength;
				}
			})
			.catch(() => stop(1011, 'UPSTREAM_WRITE_FAILED'));
		ctx.waitUntil(pendingWrites);
	});

	touch();
	ctx.waitUntil(socket.closed.catch(() => stop(1011, 'UPSTREAM_FAILED')));
	ctx.waitUntil(
		(async () => {
			try {
				while (!stopped) {
					while (!stopped && (inFlightBytes >= MAX_PENDING_BYTES || pendingFrames.length >= MAX_PENDING_FRAMES)) {
						await waitForAcknowledgement();
					}
					if (stopped) return;
					const readingAt = Date.now();
					const { value, done } = await reader.read();
					upstreamReadMs += Date.now() - readingAt;
					if (done) break;
					const data = new Uint8Array(value);
					for (let offset = 0; offset < data.byteLength && !stopped; offset += MAX_FRAME_BYTES) {
						const frame = data.subarray(offset, offset + MAX_FRAME_BYTES);
						while (!stopped && (inFlightBytes + frame.byteLength > MAX_PENDING_BYTES || pendingFrames.length >= MAX_PENDING_FRAMES)) {
							await waitForAcknowledgement();
						}
						if (stopped) return;
						if (!count(frame.byteLength)) return;
						pendingFrames.push({ bytes: frame.byteLength, sentAt: Date.now() });
						inFlightBytes += frame.byteLength;
						maxInFlightBytes = Math.max(maxInFlightBytes, inFlightBytes);
						downFrames++;
						downBytes += frame.byteLength;
						if (pendingFrames.length === 1) armAcknowledgementTimeout();
						server.send(frame);
						touch();
					}
				}
				while (!stopped && pendingFrames.length) await waitForAcknowledgement();
				stop();
			} catch {
				stop(1011, 'UPSTREAM_READ_FAILED');
			}
		})(),
	);
	return new Response(null, { status: 101, webSocket: client });
}
