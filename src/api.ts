import { SESSION_TTL_SECONDS } from './defaults';
import { createSession, getAdminPassword, getAdminUser, isDefaultCredential, requireAuth } from './auth';
import { renderLogin } from './panel';
import { saveSettings, saveMihomo, saveSingBox } from './state';
import { parseDevice, parseNetwork, subscriptionUrl } from './profiles';
import { mergeSingBox, rebuildSingCaches, validateGroupRules } from './sing-box';
import { addMihomoSubscription, addSingBoxSubscription, importMihomoProxies, updateSingBoxSubscription } from './subscriptions';
import type { AppState, Env } from './types';
import { fetchText, jsonResponse, normalizePath, parseConfigText, parseJsonObject } from './utils';

export async function handleApi(request: Request, env: Env, state: AppState): Promise<Response> {
  const url = new URL(request.url);
  const action = url.pathname.replace(/^\/api\/?/, '');

  if (action === 'login' && request.method === 'POST') {
    if (isDefaultCredential(env)) return renderLogin('默认 admin/admin 已禁用，请到 Cloudflare 控制台或 Wrangler 设置 ADMIN_PASSWORD 后再登录');

    const body = await request.formData();
    if (body.get('username') === getAdminUser(env) && body.get('password') === getAdminPassword(env)) {
      const session = await createSession(env);
      return new Response(null, {
        status: 303,
        headers: { Location: state.settings.panelPath || '/', 'Set-Cookie': `session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}` },
      });
    }
    return renderLogin('登录失败');
  }

  const authError = await requireAuth(request, env);
  if (authError) return authError;

  if (action === 'state') return renderState(state);
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const body = await readBody(request);

  if (action === 'settings') {
    state.settings.publicPath = normalizePath(body.publicPath, '/sub');
    state.settings.panelPath = normalizePath(body.panelPath, '/');
    state.settings.apiPath = normalizePath(body.apiPath, '/external-api');
    state.settings.apiToken = String(body.apiToken || '');
    state.settings.downloadToken = body.generateDownloadToken ? crypto.randomUUID() : String(body.downloadToken ?? state.settings.downloadToken).trim();
    state.settings.updatedAt = new Date().toISOString();
    await saveSettings(env, state);
    return jsonResponse({ ok: true, settings: state.settings });
  }

  if (action === 'sing/network') {
    try {
      const network = parseNetwork(body);
      const outbounds = mergeSingBox(state, 'other', true).outbounds;
      if (network.aiOutbound && !outbounds.some((item: any) => item.tag === network.aiOutbound)) return jsonResponse({ error: 'AI 出口不存在，请先在模板或订阅中添加' }, 400);
      state.singNetwork = network;
    } catch (error) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }
    await saveSingBox(env, state);
    return jsonResponse({ ok: true });
  }

  if (action === 'sing/device') {
    const existing = body.id ? state.devices.find((item) => item.id === body.id) : undefined;
    if (body.id && !existing) return jsonResponse({ error: '设备不存在' }, 404);
    try {
      const device = parseDevice(body, existing);
      state.devices = state.devices.filter((item) => item.id !== device.id).concat(device);
    } catch (error) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }
    await saveSingBox(env, state);
    return jsonResponse({ ok: true });
  }

  if (action === 'sing/device/delete' || action === 'sing/device/rotate-token') {
    const device = state.devices.find((item) => item.id === body.id);
    if (!device) return jsonResponse({ error: '设备不存在' }, 404);
    if (action.endsWith('/delete')) state.devices = state.devices.filter((item) => item.id !== device.id);
    else device.token = crypto.randomUUID();
    await saveSingBox(env, state);
    return jsonResponse({ ok: true });
  }

  if (action === 'sing/template') {
    const templateUrl = String(body.url || state.singTemplateUrl || '').trim();
    const shouldFetch = body.mode === 'fetch' || (!body.template && templateUrl);
    if (templateUrl) state.singTemplateUrl = templateUrl;
    if (shouldFetch) {
      if (!templateUrl) return jsonResponse({ error: 'Missing template URL' }, 400);
      body.template = parseJsonObject(await fetchText(templateUrl, env));
    }
    if (!body.template) return jsonResponse({ error: 'Missing template' }, 400);
    state.singTemplate = typeof body.template === 'string' ? parseJsonObject(body.template) : body.template;
    await rebuildSingCaches(env, state);
    return jsonResponse({ ok: true, templateUrl: state.singTemplateUrl, updatedAt: state.singCache.updatedAt });
  }

  if (action === 'sing/sub/add') {
    if (!body.name || !body.url) return jsonResponse({ error: 'Missing name or url' }, 400);
    const result = await addSingBoxSubscription(env, state, { id: body.id, name: String(body.name), url: String(body.url) });
    return jsonResponse({ ok: true, ...result });
  }

  if (action === 'sing/sub/update') {
    const ids = body.id ? [String(body.id)] : state.singSubs.map((sub) => sub.id);
    for (const id of ids) {
      await updateSingBoxSubscription(env, state, id);
    }
    return jsonResponse({ ok: true, updatedAt: state.singCache.updatedAt });
  }

  if (action === 'sing/sub/delete') {
    const id = String(body.id || '');
    state.singSubs = state.singSubs.filter((sub) => sub.id !== id);
    delete state.singSubConfigs[id];
    await rebuildSingCaches(env, state);
    return jsonResponse({ ok: true });
  }

  if (action === 'sing/import-mihomo') {
    if (!body.name) return jsonResponse({ error: 'Missing name' }, 400);
    const result = await importMihomoProxies(env, state, { id: body.id, name: String(body.name), url: body.url ? String(body.url) : undefined, content: String(body.content || '') });
    return jsonResponse({ ok: true, ...result });
  }

  if (action === 'sing/patches') {
    state.singPatches = {
      android: typeof body.android === 'string' ? parseJsonObject(body.android) : body.android || {},
      other: typeof body.other === 'string' ? parseJsonObject(body.other) : body.other || {},
    };
    await rebuildSingCaches(env, state);
    return jsonResponse({ ok: true, updatedAt: state.singCache.updatedAt });
  }

  if (action === 'sing/group-rules') {
    const parsed = typeof body.rules === 'string' ? parseConfigText(body.rules) : body.rules;
    state.singGroupRules = Array.isArray(parsed) ? parsed : parsed?.rules || [];
    const cycle = validateGroupRules(state.singGroupRules);
    if (cycle) return jsonResponse({ error: `Group cycle detected: ${cycle}` }, 400);
    await rebuildSingCaches(env, state);
    return jsonResponse({ ok: true, updatedAt: state.singCache.updatedAt });
  }

  if (action === 'mihomo/template') {
    const templateUrl = String(body.url || state.mihomoTemplateUrl || '').trim();
    const shouldFetch = body.mode === 'fetch' || (!body.template && templateUrl);
    if (templateUrl) state.mihomoTemplateUrl = templateUrl;
    if (shouldFetch) {
      if (!templateUrl) return jsonResponse({ error: 'Missing template URL' }, 400);
      body.template = parseConfigText(await fetchText(templateUrl, env));
    }
    if (!body.template) return jsonResponse({ error: 'Missing template' }, 400);
    const template = typeof body.template === 'string' ? parseJsonObject(body.template) : body.template;
    const providers = template['proxy-providers'] || {};
    delete template['proxy-providers'];
    state.mihomoTemplate = template;
    state.mihomoProviders = { ...providers, ...state.mihomoProviders };
    await saveMihomo(env, state);
    return jsonResponse({ ok: true, templateUrl: state.mihomoTemplateUrl });
  }

  if (action === 'mihomo/provider/add') {
    if (!body.name || !body.url) return jsonResponse({ error: 'Missing name or url' }, 400);
    const result = await addMihomoSubscription(env, state, {
      id: body.id,
      name: String(body.name),
      url: String(body.url),
      healthCheck: String(body.healthCheck || 'https://cp.cloudflare.com'),
      interval: Number(body.interval || 3600),
    });
    return jsonResponse({ ok: true, ...result });
  }

  if (action === 'mihomo/provider/delete') {
    delete state.mihomoProviders[String(body.name || '')];
    await saveMihomo(env, state);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

function renderState(state: AppState): Response {
  return jsonResponse({
    settings: state.settings,
    singSubs: state.singSubs,
    singCacheUpdatedAt: state.singCache.updatedAt,
    singTemplate: state.singTemplate,
    singPatches: state.singPatches,
    singNetwork: state.singNetwork,
    devices: state.devices.map(({ id, name, platform, wireguard }) => ({ id, name, platform, wireguardEnabled: !!wireguard })),
    mihomoTemplate: state.mihomoTemplate,
    mihomoProviders: state.mihomoProviders,
    publicUrls: {
      auto: subscriptionUrl(state),
      singBox: subscriptionUrl(state, 'sing-box'),
      singBoxAndroid: subscriptionUrl(state, 'sing-box-android'),
      mihomo: subscriptionUrl(state, 'mihomo'),
    },
  });
}

async function readBody(request: Request): Promise<any> {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) return request.json();
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}
