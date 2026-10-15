export const PROTOCOL_VERSION = 2;

export function errorResponse(status: number, code: string, headers: HeadersInit = {}): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set('Cache-Control', 'no-store');
	return Response.json({ error: { code } }, { status, headers: responseHeaders });
}

export function readTargetId(url: URL): string | Response {
	const params = url.searchParams;
	if (
		[...params.keys()].some((key) => key !== 'v' && key !== 'target') ||
		params.getAll('v').length !== 1 ||
		params.getAll('target').length !== 1
	) {
		return errorResponse(400, 'INVALID_REQUEST');
	}
	if (params.get('v') !== String(PROTOCOL_VERSION)) {
		return errorResponse(400, 'UNSUPPORTED_PROTOCOL');
	}
	const targetId = params.get('target')!;
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(targetId)) {
		return errorResponse(400, 'INVALID_TARGET');
	}
	return targetId;
}
