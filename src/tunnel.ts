import { authorize } from './auth';
import { errorResponse, readTargetId } from './protocol';
import { resolveTarget } from './targets';
import { openRelay, type ConnectRelay } from './relay';
import { authenticatePublic, reservePublic } from './public_service';

export async function handleTunnel(
	request: Request,
	env: Env,
	ctx: Pick<ExecutionContext, 'waitUntil'>,
	connectRelay?: ConnectRelay,
): Promise<Response> {
	const access = env.PUBLIC_SERVICE_ENABLED === 'true' ? await authenticatePublic(request, env) : null;
	if (access instanceof Response) return access;
	if (!access) {
		const authError = await authorize(request, env.RELAY_TOKEN);
		if (authError) return authError;
	}
	const targetId = readTargetId(new URL(request.url));
	if (targetId instanceof Response) return targetId;
	if (env.RELAY_ENABLED !== 'true') return errorResponse(501, 'TUNNEL_NOT_IMPLEMENTED');
	const target = await resolveTarget(targetId);
	if (target instanceof Response) return target;
	if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
		return errorResponse(426, 'WEBSOCKET_REQUIRED', { Upgrade: 'websocket' });
	}
	const settlement = access ? await reservePublic(access, env) : undefined;
	if (settlement instanceof Response) return settlement;
	return openRelay(target, ctx, connectRelay, request.headers.get('X-TG-Cine-Trace') ?? undefined, settlement);
}
