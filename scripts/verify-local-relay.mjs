import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
assert(process.argv[2], 'Usage: npm run test:relay -- <client-checkout>');
const clientRoot = resolve(process.argv[2]);
const runtimeDir = join(root, '.cache');
await mkdir(runtimeDir, { recursive: true });
const temp = await mkdtemp(join(runtimeDir, 'relay-proof-'));
const configPath = join(temp, 'wrangler.json');
const entryPath = join(temp, 'entry.ts');
const tokenPath = join(temp, 'token.txt');
const clients = new Set();
const echo = createServer((socket) => {
	clients.add(socket);
	socket.once('close', () => clients.delete(socket));
	socket.on('error', () => socket.destroy());
	socket.pipe(socket);
});
let worker;
let dart;
let deadline;
try {
	await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
	const echoPort = echo.address().port;
	const reservation = createServer();
	await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
	const workerPort = reservation.address().port;
	await new Promise((resolve) => reservation.close(resolve));
	const token = randomBytes(32).toString('base64url');
	await writeFile(tokenPath, token);
	// This isolated transport fixture can reach only its own ephemeral TCP echo server.
	await writeFile(
		entryPath,
		`
import { openRelay } from ${JSON.stringify(join(root, 'src/relay.ts').replaceAll('\\', '/'))};
import { authorize } from ${JSON.stringify(join(root, 'src/auth.ts').replaceAll('\\', '/'))};
import { readTargetId } from ${JSON.stringify(join(root, 'src/protocol.ts').replaceAll('\\', '/'))};
import { Hono } from ${JSON.stringify(join(root, 'node_modules/hono/dist/index.js').replaceAll('\\', '/'))};
const app = new Hono();
app.get('/health', (c) => c.json({capabilities:{tunnel:true}}));
app.get('/v2/tunnel', async (c) => {
  const denied = await authorize(c.req.raw, c.env.RELAY_TOKEN);
  if (denied) return denied;
  const target = readTargetId(new URL(c.req.url));
  if (target instanceof Response) return target;
  if (target !== 'local_echo' || c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.body(null, 400);
  return openRelay({hostname:'127.0.0.1',port:${echoPort}}, c.executionCtx);
});
export default app;
`,
	);
	await writeFile(
		configPath,
		JSON.stringify({
			name: 'tg-cine-local-relay-proof',
			main: entryPath,
			compatibility_date: '2026-10-10',
			compatibility_flags: ['nodejs_compat'],
			vars: {
				RELAY_ENABLED: 'true',
				RELAY_TOKEN: token,
			},
		}),
	);
	worker = spawn(
		process.execPath,
		[join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--strictPort', '--port', String(workerPort)],
		{
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: configPath },
		},
	);
	let startupOutput = '';
	for (const stream of [worker.stdout, worker.stderr]) {
		stream.on('data', (chunk) => {
			startupOutput = (startupOutput + chunk).slice(-16_384);
		});
	}
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (worker.exitCode !== null) throw new Error(`Local Worker exited before startup: ${startupOutput.replaceAll(token, '[redacted]')}`);
		const response = await fetch(`http://127.0.0.1:${workerPort}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
		if (response?.ok) {
			ready = (await response.json()).capabilities.tunnel === true;
			break;
		}
		await delay(100);
	}
	assert(ready, `Local Worker did not start: ${startupOutput.replaceAll(token, '[redacted]')}`);
	const packageConfig = JSON.parse(await readFile(join(clientRoot, '.dart_tool/package_config.json'), 'utf8'));
	const sdk = dirname(dirname(fileURLToPath(packageConfig.packages.find((entry) => entry.name === 'flutter').rootUri)));
	const dartCommand = join(sdk, 'bin/cache/dart-sdk/bin', process.platform === 'win32' ? 'dart.exe' : 'dart');
	dart = spawn(dartCommand, ['run', 'tool/verify_relay.dart', String(workerPort), String(echoPort), tokenPath], {
		cwd: clientRoot,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	dart.stdout.on('data', (chunk) => {
		output += chunk;
	});
	dart.stderr.on('data', (chunk) => {
		output += chunk;
	});
	const result = await Promise.race([
		new Promise((resolve, reject) => {
			dart.once('error', reject);
			dart.once('exit', (code) => resolve(code));
		}),
		new Promise((_, reject) => {
			deadline = setTimeout(() => reject(new Error(`Local relay proof timed out: ${output.replaceAll(token, '[redacted]')}`)), 30_000);
		}),
	]);
	assert.equal(result, 0, output.replaceAll(token, '[redacted]'));
	assert.match(output, /Verified 1048576 ordered bytes/);
	console.log(output.trim());
} finally {
	clearTimeout(deadline);
	for (const child of [dart, worker]) {
		if (child && child.exitCode === null) {
			const exited = new Promise((resolve) => child.once('exit', resolve));
			child.kill();
			await exited;
		}
	}
	for (const socket of clients) socket.destroy();
	await new Promise((resolve) => echo.close(resolve));
	assert(resolve(temp).startsWith(`${runtimeDir}${sep}relay-proof-`), 'Cleanup must remain in the generated local fixture directory');
	await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
