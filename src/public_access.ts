import { DurableObject } from 'cloudflare:workers';
import { MAX_SESSION_BYTES, SESSION_MS } from './relay';

export const ACCESS_MS = 10 * 60 * 1000;
export const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_DAILY_BYTES = 1024 * 1024 * 1024;
export const GLOBAL_DAILY_BYTES = 4 * DEVICE_DAILY_BYTES;
export const MAX_DEVICE_CONNECTIONS = 6;
const day = () => Math.floor(Date.now() / 86_400_000);

type Session = { refresh: string; access: string; access_expires: number; expires: number; revoked: number };
type Lease = { id: string; day: number; expires: number };

/** One object per installation; Telegram identity and messages never enter this store. */
export class DeviceSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK(id=1), refresh TEXT, access TEXT, access_expires INTEGER, expires INTEGER, revoked INTEGER);
CREATE TABLE IF NOT EXISTS usage (day INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, day INTEGER NOT NULL, expires INTEGER NOT NULL);`);
	}

	async enroll(refresh: string, access: string): Promise<number> {
		if (this.row()) throw new Error('Already enrolled');
		const now = Date.now();
		this.ctx.storage.sql.exec('INSERT INTO session VALUES (1,?,?,?,?,0)', refresh, access, now + ACCESS_MS, now + REFRESH_MS);
		await this.ctx.storage.setAlarm(now + REFRESH_MS);
		return now + ACCESS_MS;
	}

	private row(): Session | undefined {
		return this.ctx.storage.sql.exec<Session>('SELECT * FROM session WHERE id=1').toArray()[0];
	}

	private valid(hash: string, refresh = false): boolean {
		const row = this.row();
		if (!row || row.revoked || row.expires <= Date.now() || (!refresh && row.access_expires <= Date.now())) return false;
		return crypto.subtle.timingSafeEqual(new TextEncoder().encode(hash), new TextEncoder().encode(refresh ? row.refresh : row.access));
	}

	refresh(refresh: string, access: string): number | null {
		if (!this.valid(refresh, true)) return null;
		const expires = Date.now() + ACCESS_MS;
		this.ctx.storage.sql.exec('UPDATE session SET access=?,access_expires=? WHERE id=1', access, expires);
		return expires;
	}

	revoke(refresh: string): boolean {
		if (!this.valid(refresh, true)) return false;
		this.ctx.storage.sql.exec('UPDATE session SET revoked=1 WHERE id=1');
		return true;
	}

	authenticate(access: string): boolean {
		return this.valid(access);
	}

	reserve(access: string, leaseId: string): 'ok' | 'unauthorized' | 'limited' {
		return this.ctx.storage.transactionSync(() => {
			const bucket = day();
			if (!this.valid(access)) return 'unauthorized';
			this.ctx.storage.sql.exec('DELETE FROM leases WHERE expires<=?', Date.now());
			this.ctx.storage.sql.exec('DELETE FROM usage WHERE day<?', bucket - 1);
			const count = this.ctx.storage.sql.exec<{ total: number }>('SELECT count(*) AS total FROM leases').one().total;
			const spent = this.ctx.storage.sql.exec<{ bytes: number }>('SELECT bytes FROM usage WHERE day=?', bucket).toArray()[0]?.bytes ?? 0;
			if (count >= MAX_DEVICE_CONNECTIONS || spent + MAX_SESSION_BYTES > DEVICE_DAILY_BYTES) return 'limited';
			this.ctx.storage.sql.exec('INSERT INTO leases VALUES (?,?,?)', leaseId, bucket, Date.now() + SESSION_MS + 30_000);
			this.ctx.storage.sql.exec(
				'INSERT INTO usage VALUES (?,?) ON CONFLICT(day) DO UPDATE SET bytes=bytes+excluded.bytes',
				bucket,
				MAX_SESSION_BYTES,
			);
			return 'ok';
		});
	}

	settle(leaseId: string, bytes: number): void {
		this.ctx.storage.transactionSync(() => {
			if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_SESSION_BYTES) throw new Error('Invalid settlement');
			const lease = this.ctx.storage.sql.exec<Lease>('SELECT * FROM leases WHERE id=?', leaseId).toArray()[0];
			if (!lease) return;
			this.ctx.storage.sql.exec('UPDATE usage SET bytes=bytes-? WHERE day=?', MAX_SESSION_BYTES - bytes, lease.day);
			this.ctx.storage.sql.exec('DELETE FROM leases WHERE id=?', leaseId);
		});
	}

	async alarm(): Promise<void> {
		this.ctx.storage.sql.exec('DELETE FROM session; DELETE FROM usage; DELETE FROM leases;');
	}
}

/** Coordinates only the global daily bandwidth budget, not device authentication. */
export class ServiceBudget extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
CREATE TABLE IF NOT EXISTS usage (day INTEGER PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, day INTEGER NOT NULL, expires INTEGER NOT NULL);`);
	}

	private prepare(bucket: number) {
		this.ctx.storage.sql.exec('DELETE FROM leases WHERE expires<=?', Date.now());
		this.ctx.storage.sql.exec('DELETE FROM usage WHERE day<?', bucket - 1);
		this.ctx.storage.sql.exec('INSERT OR IGNORE INTO usage(day) VALUES (?)', bucket);
	}

	reserve(leaseId: string): boolean {
		return this.ctx.storage.transactionSync(() => {
			const bucket = day();
			this.prepare(bucket);
			const bytes = this.ctx.storage.sql.exec<{ bytes: number }>('SELECT bytes FROM usage WHERE day=?', bucket).one().bytes;
			if (bytes + MAX_SESSION_BYTES > GLOBAL_DAILY_BYTES) return false;
			this.ctx.storage.sql.exec('INSERT INTO leases VALUES (?,?,?)', leaseId, bucket, Date.now() + SESSION_MS + 30_000);
			this.ctx.storage.sql.exec('UPDATE usage SET bytes=bytes+? WHERE day=?', MAX_SESSION_BYTES, bucket);
			return true;
		});
	}

	settle(leaseId: string, bytes: number): void {
		this.ctx.storage.transactionSync(() => {
			if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_SESSION_BYTES) throw new Error('Invalid settlement');
			const lease = this.ctx.storage.sql.exec<Lease>('SELECT * FROM leases WHERE id=?', leaseId).toArray()[0];
			if (!lease) return;
			this.ctx.storage.sql.exec('UPDATE usage SET bytes=bytes-? WHERE day=?', MAX_SESSION_BYTES - bytes, lease.day);
			this.ctx.storage.sql.exec('DELETE FROM leases WHERE id=?', leaseId);
		});
	}
}
