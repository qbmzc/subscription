import type { AppState, DevicePlatform, DeviceProfile, JsonMap, SingNetwork } from './types';
import { clone, parseJsonObject, unique } from './utils';

export const DEVICE_PLATFORMS: DevicePlatform[] = ['android', 'ios', 'macos', 'windows', 'linux'];

export function parseNetwork(input: Record<string, unknown>): SingNetwork {
  const companyDns = String(input.companyDns || '').trim();
  const companyDomains = parseDomains(input.companyDomains);
  const wireguardCidrs = parseLines(input.wireguardCidrs);
  const aiDomains = parseDomains(input.aiDomains);
  const aiOutbound = String(input.aiOutbound || '').trim();
  if (companyDomains.length && !isIpAddress(companyDns)) throw new Error('公司 DNS 必须填写 IP 地址；停用时请清空公司域名');
  if (!wireguardCidrs.every(isCidr)) throw new Error('WireGuard 网段必须是有效的 IP/CIDR');
  if (aiDomains.length && !aiOutbound) throw new Error('请选择 AI 出口');
  return { companyDns, companyDomains, wireguardCidrs, aiDomains, aiOutbound };
}

export function parseDevice(input: Record<string, unknown>, existing?: DeviceProfile): DeviceProfile {
  const name = String(input.name || '').trim();
  const platform = String(input.platform || '') as DevicePlatform;
  if (!name) throw new Error('请填写设备名称');
  if (!DEVICE_PLATFORMS.includes(platform)) throw new Error('不支持的设备平台');
  const text = String(input.wireguard || '').trim();
  const wireguard = text ? parseJsonObject(text) : null;
  if (wireguard) validateWireguard(wireguard);
  return {
    id: existing?.id || crypto.randomUUID(),
    name,
    platform,
    token: existing?.token || crypto.randomUUID(),
    wireguard,
  };
}

export function buildProfile(base: JsonMap, network: SingNetwork, device?: DeviceProfile): JsonMap {
  const config = clone(base);
  for (const inbound of config.inbounds || []) {
    if (inbound.type === 'mixed') inbound.listen = '127.0.0.1';
  }
  // auto_redirect is Linux-only.
  if (device?.platform !== 'linux') {
    for (const inbound of config.inbounds || []) delete inbound.auto_redirect;
  }
  const rules: JsonMap[] = [];
  config.route ||= {};
  if (device?.wireguard) {
    const endpoint = { ...clone(device.wireguard), type: 'wireguard', tag: 'wg-private', system: false, detour: 'direct' };
    config.endpoints = [...(config.endpoints || []).filter((item: JsonMap) => item.tag !== endpoint.tag), endpoint];
    if (network.wireguardCidrs.length) rules.push({ ip_cidr: network.wireguardCidrs, action: 'route', outbound: endpoint.tag });
  }
  if (network.companyDomains.length) {
    config.dns ||= {};
    config.dns.servers = [
      ...(config.dns.servers || []).filter((server: JsonMap) => server.tag !== 'dns-company'),
      { type: 'udp', tag: 'dns-company', server: network.companyDns, detour: 'direct' },
    ];
    config.dns.rules = [{ domain_suffix: network.companyDomains, action: 'route', server: 'dns-company' }, ...(config.dns.rules || [])];
    rules.push({ domain_suffix: network.companyDomains, action: 'route', outbound: 'direct' });
  }
  if (network.aiDomains.length) rules.push({ domain_suffix: network.aiDomains, action: 'route', outbound: network.aiOutbound });
  const existingRules: JsonMap[] = config.route.rules || [];
  if (network.aiOutbound) {
    for (const rule of existingRules) {
      if (rule.outbound === '⌨️ AI') rule.outbound = network.aiOutbound;
    }
  }
  const firstRoute = existingRules.findIndex((rule) => rule.outbound || ['route', 'reject', 'bypass'].includes(rule.action));
  // Preserve sniffing/DNS interception before inserting routes ahead of private-address bypass.
  const insertion = firstRoute < 0 ? existingRules.length : firstRoute;
  config.route.rules = [...existingRules.slice(0, insertion), ...rules, ...existingRules.slice(insertion)];
  return config;
}

export function subscriptionUrl(state: AppState, target = '', device?: DeviceProfile): string {
  const query = new URLSearchParams();
  if (device) query.set('device', device.id);
  if (target) query.set('target', target);
  const token = device?.token || state.settings.downloadToken;
  if (token) query.set('token', token);
  return `${state.settings.publicPath}${query.size ? `?${query}` : ''}`;
}

function parseLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) throw new Error('列表项必须是字符串');
    return unique(value.map((item) => item.trim()).filter(Boolean));
  }
  if (value !== undefined && typeof value !== 'string') throw new Error('请填写文本或字符串列表');
  return unique((value || '').split(/[\s,]+/).filter(Boolean));
}

function parseDomains(value: unknown): string[] {
  const domains = parseLines(value).map((domain) => domain.toLowerCase());
  if (!domains.every((domain) => domain.length <= 253 && domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
    throw new Error('域名请填写纯域名，不带协议、端口、路径或通配符；后缀规则已包含子域名');
  }
  return unique(domains);
}

function isIpAddress(value: string): boolean {
  if (value.includes(':')) {
    try { return new URL(`http://[${value}]/`).hostname.startsWith('['); } catch { return false; }
  }
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isCidr(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  return extra === undefined && isIpAddress(address) && /^\d+$/.test(prefix || '') && Number(prefix) <= (address.includes(':') ? 128 : 32);
}

function validateWireguard(endpoint: JsonMap): void {
  if (endpoint.type !== 'wireguard') throw new Error('请填写 type 为 wireguard 的 endpoint 对象');
  if (!Array.isArray(endpoint.address) || !endpoint.address.length || !endpoint.address.every((value: unknown) => typeof value === 'string' && isCidr(value))) {
    throw new Error('WireGuard address 必须包含该设备的 IP/CIDR');
  }
  const isKey = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
  if (!isKey(endpoint.private_key)) throw new Error('请填写有效的 WireGuard private_key');
  if (!Array.isArray(endpoint.peers) || !endpoint.peers.length) throw new Error('WireGuard 至少需要一个 peer');
  for (const peer of endpoint.peers) {
    if (!peer || !isKey(peer.public_key) || typeof peer.address !== 'string' || !peer.address.trim() || !Number.isInteger(peer.port) || peer.port < 1 || peer.port > 65535) {
      throw new Error('WireGuard peer 需要 public_key、address 和有效 port');
    }
    if (peer.pre_shared_key && !isKey(peer.pre_shared_key)) throw new Error('无效的 WireGuard pre_shared_key');
    if (!Array.isArray(peer.allowed_ips) || !peer.allowed_ips.length || !peer.allowed_ips.every((value: unknown) => typeof value === 'string' && isCidr(value))) {
      throw new Error('WireGuard peer.allowed_ips 必须是 IP/CIDR 列表');
    }
  }
}
