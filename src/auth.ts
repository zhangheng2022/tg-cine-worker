import { errorResponse } from './protocol';

export async function authorize(request: Request, token: string | undefined): Promise<Response | null> {
	if (typeof token !== 'string' || token.trim().length === 0) {
		return errorResponse(503, 'AUTH_NOT_CONFIGURED');
	}
	const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '');
	if (match) {
		const encoder = new TextEncoder();
		const [provided, expected] = await Promise.all([
			crypto.subtle.digest('SHA-256', encoder.encode(match[1])),
			crypto.subtle.digest('SHA-256', encoder.encode(token)),
		]);
		if (crypto.subtle.timingSafeEqual(provided, expected)) {
			return null;
		}
	}
	return errorResponse(401, 'UNAUTHORIZED', { 'WWW-Authenticate': 'Bearer' });
}
