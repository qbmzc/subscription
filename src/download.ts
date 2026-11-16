import { buildMihomo } from './mihomo';
import { mergeSingBox, rebuildSingCaches } from './sing-box';
import { buildProfile } from './profiles';
import type { AppState, Env } from './types';
import { jsonResponse } from './utils';

export async function downloadConfig(request: Request, env: Env, state: AppState): Promise<Response> {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('device');
  const device = deviceId ? state.devices.find((item) => item.id === deviceId) : undefined;
  const expectedToken = deviceId ? device?.token : state.settings.downloadToken;
  const suppliedToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || url.searchParams.get('token');
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'User-Agent, Authorization' };
  if ((deviceId && !device) || ((deviceId || expectedToken) && suppliedToken !== expectedToken)) {
    const response = jsonResponse({ error: 'Unauthorized' }, 401);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
  const target = device ? (device.platform === 'android' ? 'sing-box-android' : 'sing-box') : detectTarget(request, url);

  if (target === 'mihomo') {
    return new Response(buildMihomo(state), {
      headers: {
        ...headers,
        'Content-Type': 'application/yaml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="mihomo.yaml"',
      },
    });
  }

  let config;
  if (device) {
    const base = mergeSingBox(state, device.platform === 'android' ? 'android' : 'other', true);
    config = buildProfile(base, state.singNetwork, device);
  } else {
    if (!state.singCache.android || !state.singCache.other) await rebuildSingCaches(env, state);
    config = target === 'sing-box-android' ? state.singCache.android : state.singCache.other;
  }
  return new Response(JSON.stringify(config, null, 2), {
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${target}.json"`,
    },
  });
}

function detectTarget(request: Request, url: URL): 'mihomo' | 'sing-box-android' | 'sing-box' {
  const target = (url.searchParams.get('target') || url.searchParams.get('format') || '').toLowerCase();
  if (['mihomo', 'clash', 'clash-meta', 'yaml'].includes(target)) return 'mihomo';
  if (['sing-box-android', 'android', 'sfa'].includes(target)) return 'sing-box-android';
  if (['sing-box', 'singbox', 'json'].includes(target)) return 'sing-box';

  const ua = request.headers.get('User-Agent') || '';
  if (/mihomo|clash|stash|verge|meta/i.test(ua)) return 'mihomo';
  if (/SFA|sing-box.*android|Android/i.test(ua)) return 'sing-box-android';
  return 'sing-box';
}
