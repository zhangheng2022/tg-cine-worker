import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_BYTES, MAX_PENDING_BYTES, MAX_PENDING_FRAMES, type RelaySocket } from '../src/relay';
import { handleTunnel } from '../src/tunnel';

vi.mock('../src/targets', async (original) => ({
	...(await original<typeof import('../src/targets')>()),
	resolveTarget: async () => ({ hostname: 'upstream.example', port: 443 }),
}));

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const configured: Env = {
	...env,
	RELAY_ENABLED: 'true',
	RELAY_TOKEN: 'test-token',
};
function request(headers: HeadersInit = { Authorization: 'Bearer test-token', Upgrade: 'websocket' }) {
	return new IncomingRequest('https://worker.example/v2/tunnel?v=2&target=dc2', { headers });
}

function upstream(write: (chunk: Uint8Array) => void | Promise<void> = () => {}) {
	let incoming!: ReadableStreamDefaultController<Uint8Array>;
	const close = vi.fn(async () => {});
	const socket: RelaySocket = {
		readable: new ReadableStream<Uint8Array>({
			start(controller) {
				incoming = controller;
			},
		}),
		writable: new WritableStream<Uint8Array>({ write }),
		opened: Promise.resolve({}),
		closed: Promise.resolve(),
		close,
	};
	return { socket, close, send: (data: Uint8Array) => incoming.enqueue(data), end: () => incoming.close() };
}

function nextMessage(socket: WebSocket): Promise<string | ArrayBuffer> {
	return new Promise((resolve) =>
		socket.addEventListener('message', (event) => resolve(event.data as string | ArrayBuffer), { once: true }),
	);
}

async function closed(socket: WebSocket): Promise<CloseEvent> {
	return new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
}

describe('受限双向中转', () => {
	it('关闭时只记录有界脱敏的传输统计', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const source = upstream();
		const ctx = createExecutionContext();
		const response = await handleTunnel(
			request({ Authorization: 'Bearer test-token', Upgrade: 'websocket', 'X-TG-Cine-Trace': 'a'.repeat(32) }),
			configured,
			ctx,
			() => source.socket,
		);
		const client = response.webSocket!;
		client.accept();
		const incoming = nextMessage(client);
		source.send(new Uint8Array([1, 2, 3]));
		await incoming;
		client.send('ACK');
		const closing = closed(client);
		source.end();
		await closing;
		client.close();
		await waitOnExecutionContext(ctx);
		expect(JSON.parse(log.mock.calls[0][0])).toEqual(
			expect.objectContaining({ event: 'relay_closed', traceId: 'a'.repeat(32), downBytes: 3, downFrames: 1 }),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain('test-token');
		expect(JSON.stringify(log.mock.calls)).not.toContain('upstream.example');
		log.mockRestore();
	});
	afterEach(() => vi.useRealTimers());
	it('连接超时返回 502 并清理；空闲连接到期关闭', async () => {
		vi.useFakeTimers();
		const source = upstream();
		const ctx = createExecutionContext();
		const pending = handleTunnel(request(), configured, ctx, () => ({ ...source.socket, opened: new Promise(() => {}) }));
		await vi.advanceTimersByTimeAsync(5001);
		expect((await pending).status).toBe(502);
		await waitOnExecutionContext(ctx);
		expect(source.close).toHaveBeenCalledOnce();
		const idleSource = upstream();
		const idleCtx = createExecutionContext();
		const response = await handleTunnel(request(), configured, idleCtx, () => idleSource.socket);
		const client = response.webSocket!;
		client.accept();
		const close = closed(client);
		await vi.advanceTimersByTimeAsync(30_001);
		expect((await close).reason).toBe('IDLE_TIMEOUT');
		client.close();
		await waitOnExecutionContext(idleCtx);
		expect(idleSource.close).toHaveBeenCalledOnce();
	});
	it('持续传输超过旧的 64 MiB 和 15 分钟上限仍保持连接', async () => {
		vi.useFakeTimers();
		const source = upstream();
		const ctx = createExecutionContext();
		const client = (await handleTunnel(request(), configured, ctx, () => source.socket)).webSocket!;
		client.accept();
		let ended = false;
		client.addEventListener('close', () => {
			ended = true;
		});
		try {
			for (let index = 0; index < 1025; index++) {
				const ack = nextMessage(client);
				client.send(new Uint8Array(MAX_FRAME_BYTES));
				expect(await ack).toBe('ACK');
				await vi.advanceTimersByTimeAsync(1000);
			}
			expect(ended).toBe(false);
			expect(source.close).not.toHaveBeenCalled();
		} finally {
			client.close();
			await waitOnExecutionContext(ctx);
		}
		expect(source.close).toHaveBeenCalledOnce();
	}, 30000);
	it('未授权请求不会打开上游', async () => {
		const connect = vi.fn(() => upstream().socket);
		const response = await handleTunnel(request({ Upgrade: 'websocket' }), configured, createExecutionContext(), connect);
		expect(response.status).toBe(401);
		expect(connect).not.toHaveBeenCalled();
	});
	it('上游连接失败返回脱敏 502，关闭已创建的套接字', async () => {
		const source = upstream();
		const socket = { ...source.socket, opened: Promise.reject(new Error('private upstream detail')) };
		const response = await handleTunnel(request(), configured, createExecutionContext(), () => socket);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
		expect(source.close).toHaveBeenCalledOnce();
	});
	it('按顺序写入并确认，下行窗口内无需逐帧等待确认', async () => {
		const writes: number[][] = [];
		const source = upstream((data) => {
			writes.push([...data]);
		});
		const ctx = createExecutionContext();
		const connect = vi.fn(() => source.socket);
		const response = await handleTunnel(request(), configured, ctx, connect);
		expect(connect).toHaveBeenCalledWith({ hostname: 'upstream.example', port: 443 });
		expect(response.status).toBe(101);
		const client = response.webSocket!;
		client.binaryType = 'arraybuffer';
		client.accept();
		const ack = nextMessage(client);
		client.send(new Uint8Array([0, 1, 255]));
		expect(await ack).toBe('ACK');
		expect(writes).toEqual([[0, 1, 255]]);
		const received: ArrayBuffer[] = [];
		client.addEventListener('message', (event) => {
			if (event.data instanceof ArrayBuffer) received.push(event.data);
		});
		source.send(new Uint8Array(MAX_FRAME_BYTES + 3).fill(42));
		await vi.waitFor(() => expect(received).toHaveLength(2));
		expect(received[0].byteLength).toBe(MAX_FRAME_BYTES);
		expect([...new Uint8Array(received[1])]).toEqual([42, 42, 42]);
		client.send('ACK');
		client.send('ACK');
		client.close();
		await waitOnExecutionContext(ctx);
		expect(source.close).toHaveBeenCalledOnce();
	});
	it.each([
		{ bytes: MAX_FRAME_BYTES, frames: MAX_PENDING_BYTES / MAX_FRAME_BYTES },
		{ bytes: 1, frames: MAX_PENDING_FRAMES },
	])('窗口受字节和帧数限制，确认后只释放相应空间 $bytes', async ({ bytes, frames }) => {
		const source = upstream();
		const ctx = createExecutionContext();
		const client = (await handleTunnel(request(), configured, ctx, () => source.socket)).webSocket!;
		client.binaryType = 'arraybuffer';
		client.accept();
		const received: Uint8Array[] = [];
		client.addEventListener('message', (event) => {
			received.push(new Uint8Array(event.data as ArrayBuffer));
		});
		for (let index = 0; index <= frames; index++) source.send(new Uint8Array(bytes).fill(index));
		await vi.waitFor(() => expect(received).toHaveLength(frames));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(received).toHaveLength(frames);
		client.send('ACK');
		await vi.waitFor(() => expect(received).toHaveLength(frames + 1));
		expect(received.map((frame) => frame[0])).toEqual(Array.from({ length: frames + 1 }, (_, index) => index));
		client.close();
		await waitOnExecutionContext(ctx);
		expect(source.close).toHaveBeenCalledOnce();
	});
	it('上游结束后等待所有下行确认才关闭，兼容逐帧确认客户端', async () => {
		const source = upstream();
		const ctx = createExecutionContext();
		const client = (await handleTunnel(request(), configured, ctx, () => source.socket)).webSocket!;
		client.binaryType = 'arraybuffer';
		client.accept();
		const first = nextMessage(client);
		source.send(new Uint8Array([1, 2, 3]));
		source.send(new Uint8Array([4]));
		source.end();
		expect([...new Uint8Array((await first) as ArrayBuffer)]).toEqual([1, 2, 3]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.readyState).toBe(WebSocket.OPEN);
		const close = closed(client);
		client.send('ACK');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.readyState).toBe(WebSocket.OPEN);
		client.send('ACK');
		expect((await close).code).toBe(1000);
		client.close();
		await waitOnExecutionContext(ctx);
		expect(source.close).toHaveBeenCalledOnce();
	});
	it('不同大小帧按 FIFO 释放字节，不能用小帧确认释放大帧空间', async () => {
		const source = upstream();
		const ctx = createExecutionContext();
		const client = (await handleTunnel(request(), configured, ctx, () => source.socket)).webSocket!;
		client.binaryType = 'arraybuffer';
		client.accept();
		const lengths: number[] = [];
		client.addEventListener('message', (event) => {
			lengths.push((event.data as ArrayBuffer).byteLength);
		});
		const sizes = [1, MAX_FRAME_BYTES, MAX_FRAME_BYTES, MAX_FRAME_BYTES, MAX_FRAME_BYTES - 1];
		for (const size of [...sizes, 2]) source.send(new Uint8Array(size));
		await vi.waitFor(() => expect(lengths).toEqual(sizes));
		client.send('ACK');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(lengths).toEqual(sizes);
		client.send('ACK');
		await vi.waitFor(() => expect(lengths).toEqual([...sizes, 2]));
		client.close();
		await waitOnExecutionContext(ctx);
		expect(source.close).toHaveBeenCalledOnce();
	});
	it('其他活动不能无限延后最老帧的确认超时，关闭后释放等待', async () => {
		vi.useFakeTimers();
		const source = upstream();
		const ctx = createExecutionContext();
		const client = (await handleTunnel(request(), configured, ctx, () => source.socket)).webSocket!;
		client.accept();
		const first = nextMessage(client);
		for (let index = 0; index <= MAX_PENDING_FRAMES; index++) source.send(new Uint8Array([index]));
		await first;
		await vi.advanceTimersByTimeAsync(15_000);
		const ack = nextMessage(client);
		client.send(new Uint8Array([1]));
		expect(await ack).toBe('ACK');
		const close = closed(client);
		await vi.advanceTimersByTimeAsync(15_001);
		expect((await close).reason).toBe('ACK_TIMEOUT');
		client.close();
		await waitOnExecutionContext(ctx);
		expect(source.close).toHaveBeenCalledOnce();
	});
	it.each(['arbitrary text', 'ACK', new Uint8Array(MAX_FRAME_BYTES + 1), new Uint8Array(0)])('拒绝非法帧并清理资源 %#', async (frame) => {
		const source = upstream();
		const ctx = createExecutionContext();
		const response = await handleTunnel(request(), configured, ctx, () => source.socket);
		const client = response.webSocket!;
		client.accept();
		const close = closed(client);
		client.send(frame);
		expect((await close).code).toBe(typeof frame === 'string' ? 1003 : 1009);
		client.close();
		await waitOnExecutionContext(ctx);
		expect(source.close).toHaveBeenCalledOnce();
	});
	it('慢上游的待写队列到达上限时关闭，不无限缓冲', async () => {
		let release!: () => void;
		const source = upstream(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const ctx = createExecutionContext();
		const response = await handleTunnel(request(), configured, ctx, () => source.socket);
		const client = response.webSocket!;
		client.accept();
		const close = closed(client);
		for (let i = 0; i <= MAX_PENDING_BYTES / MAX_FRAME_BYTES; i++) client.send(new Uint8Array(MAX_FRAME_BYTES));
		expect((await close).code).toBe(1009);
		release();
		client.close();
		await waitOnExecutionContext(ctx);
		expect(source.close).toHaveBeenCalledOnce();
	});
});
