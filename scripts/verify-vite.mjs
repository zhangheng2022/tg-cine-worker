import { strict as assert } from 'node:assert';
import { createServer, preview } from 'vite';

for (const mode of ['dev', 'preview']) {
	const options = { host: '127.0.0.1', port: 0, strictPort: true };
	const server = mode === 'dev' ? await createServer({ server: options }) : await preview({ preview: options });
	try {
		if (mode === 'dev') await server.listen();
		const base = `http://127.0.0.1:${server.httpServer.address().port}`;
		const health = await fetch(`${base}/health`);
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), {
			service: 'tg-cine-worker',
			status: 'ok',
			protocolVersion: 2,
			capabilities: { tunnel: false },
		});
		const removed = await fetch(`${base}/v1/config`);
		assert.equal(removed.status, 404);
		const wrongMethod = await fetch(`${base}/health`, { method: 'POST' });
		assert.equal(wrongMethod.status, 405);
		assert.equal(wrongMethod.headers.get('allow'), 'GET');
		const disabled = await fetch(`${base}/v2/devices`, { method: 'POST' });
		assert.equal(disabled.status, 503);
		console.log(`Vite ${mode}: health, v2-only routing, method guard and disabled service passed`);
	} finally {
		await server.close();
	}
}
