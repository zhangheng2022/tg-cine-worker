import { DurableObject } from 'cloudflare:workers';

export const ACCESS_MS = 10 * 60 * 1000;
export const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
type Session = { refresh: string; access: string; access_expires: number; expires: number; revoked: number };

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

	async alarm(): Promise<void> {
		this.ctx.storage.sql.exec('DELETE FROM session; DELETE FROM usage; DELETE FROM leases;');
	}
}

/** Retains the deployed namespace and its data; playback no longer consults this ledger. */
export class ServiceBudget extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
CREATE TABLE IF NOT EXISTS usage (day INTEGER PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, day INTEGER NOT NULL, expires INTEGER NOT NULL);`);
	}
}
