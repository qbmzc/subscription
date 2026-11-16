import { COUNTRY_RULES, DEFAULT_SING_TEMPLATE } from './defaults';
import { saveSingBox } from './state';
import type { AppState, Env, JsonMap, SingGroupRule } from './types';
import { clone, deepMerge, unique } from './utils';

export async function rebuildSingCaches(env: Env, state: AppState): Promise<void> {
  state.singCache = {
    android: mergeSingBox(state, 'android'),
    other: mergeSingBox(state, 'other'),
    updatedAt: new Date().toISOString(),
  };
  await saveSingBox(env, state);
}

export function mergeSingBox(state: AppState, platform: 'android' | 'other', modern = false): JsonMap {
  const template = clone(state.singTemplate || DEFAULT_SING_TEMPLATE);
  const templateOutbounds = Array.isArray(template.outbounds) ? template.outbounds : [];
  const subscriptionOutbounds = modern ? collectSubscriptionNodes(state) : Object.values(state.singSubConfigs)
    .flatMap((config) => (Array.isArray(config?.outbounds) ? config.outbounds : []))
    .filter((outbound) => outbound?.tag && !isRuleOutbound(outbound) && !isGroupOutbound(outbound));

  const nodeByTag = new Map<string, any>();
  for (const outbound of subscriptionOutbounds) nodeByTag.set(outbound.tag, outbound);
  const nodeTags = [...nodeByTag.keys()];
  const regionMap = new Map<string, string[]>();
  for (const tag of nodeTags) {
    const region = inferRegion(modern ? tag.slice(tag.indexOf(' | ') + 3) : tag);
    regionMap.set(region, [...(regionMap.get(region) || []), tag]);
  }

  const generatedRegions = [...regionMap.entries()].map(([tag, outbounds]) => ({
    type: 'urltest',
    tag,
    outbounds: unique(outbounds),
    url: 'https://cp.cloudflare.com',
    interval: '5m',
  }));
  const regionTags = generatedRegions.map((group) => group.tag);
  const templateRegionTags = COUNTRY_RULES.map((rule) => rule.tag).concat('🌐OTHER');

  const rebuiltOutbounds: any[] = [];
  for (const outbound of templateOutbounds) {
    if (!outbound?.tag) continue;
    if (templateRegionTags.includes(outbound.tag) || outbound.tag === '🔥AUTO') continue;
    if (isGroupOutbound(outbound) && Array.isArray(outbound.outbounds)) {
      const outbounds: string[] = outbound.outbounds.flatMap((tag: string) => (templateRegionTags.includes(tag) ? regionTags : [tag]));
      const filteredOutbounds = applyGroupRule(outbound.tag, unique(outbounds), state.singGroupRules, [...nodeByTag.values()], regionTags);
      rebuiltOutbounds.push({
        ...outbound,
        outbounds: filteredOutbounds.filter(
          (tag) => regionTags.includes(tag) || nodeTags.includes(tag) || tag === 'direct' || tag === 'block' || tag === '🔥AUTO' || hasOutboundTag(templateOutbounds, tag),
        ),
      });
    } else if (!nodeByTag.has(outbound.tag)) {
      rebuiltOutbounds.push(outbound);
    }
  }

  if (nodeTags.length > 0 || modern) {
    rebuiltOutbounds.push({
      type: 'urltest',
      tag: '🔥AUTO',
      outbounds: nodeTags.length ? nodeTags : ['direct'],
      url: 'https://cp.cloudflare.com',
      interval: '15m',
    });
  }
  rebuiltOutbounds.push(...generatedRegions);
  rebuiltOutbounds.push(...nodeByTag.values());

  template.outbounds = dedupeOutbounds(rebuiltOutbounds);
  if (!hasOutboundTag(template.outbounds, 'direct')) template.outbounds.push({ type: 'direct', tag: 'direct' });
  if (!modern && !hasOutboundTag(template.outbounds, 'block')) template.outbounds.push({ type: 'block', tag: 'block' });

  const patched = deepMerge(template, state.singPatches[platform] || {});
  if (platform !== 'android' && patched.route) delete patched.route.override_android_vpn;
  return modern ? migrateSingBox(patched) : patched;
}

function collectSubscriptionNodes(state: AppState): any[] {
  return Object.entries(state.singSubConfigs).flatMap(([id, config]) => {
    const source = state.singSubs.find((sub) => sub.id === id)?.name || id;
    const nodes = (config.outbounds || []).filter((node: any) => node?.tag && !isRuleOutbound(node) && !isGroupOutbound(node));
    const tags = new Map<string, string>(nodes.map((node: any) => [node.tag, `${source} | ${node.tag}`]));
    return nodes.map((node: any) => {
      const result = { ...clone(node), tag: tags.get(node.tag) };
      if (tags.has(node.detour)) result.detour = tags.get(node.detour);
      return result;
    });
  });
}

export function migrateSingBox(config: JsonMap): JsonMap {
  const rejected = new Set<string>((config.outbounds || []).filter((node: any) => node.type === 'block').map((node: any) => node.tag));
  const legacyBlockGroup = (config.outbounds || []).find((node: any) => node.tag === '🏴‍☠️全球拦截' && node.outbounds?.some((tag: string) => rejected.has(tag)));
  if (legacyBlockGroup) rejected.add(legacyBlockGroup.tag);
  config.outbounds = (config.outbounds || []).filter((node: any) => !rejected.has(node.tag));
  for (const node of config.outbounds) {
    if (node.outbounds) node.outbounds = node.outbounds.filter((tag: string) => !rejected.has(tag));
    if (rejected.has(node.default)) delete node.default;
  }
  for (const rule of config.route?.rules || []) {
    if (rejected.has(rule.outbound)) {
      delete rule.outbound;
      rule.action = 'reject';
    }
  }
  return config;
}

function isRuleOutbound(outbound: any): boolean {
  return ['direct', 'block', 'dns'].includes(outbound?.type);
}

function isGroupOutbound(outbound: any): boolean {
  return ['selector', 'urltest', 'url-test', 'fallback', 'loadbalance'].includes(outbound?.type);
}

function inferRegion(tag: string): string {
  for (const rule of COUNTRY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(tag))) return rule.tag;
  }
  return '🌐OTHER';
}

function hasOutboundTag(outbounds: any[], tag: string): boolean {
  return outbounds.some((outbound) => outbound?.tag === tag);
}

function dedupeOutbounds(outbounds: any[]): any[] {
  const seen = new Set<string>();
  const output: any[] = [];
  for (const outbound of outbounds) {
    if (!outbound?.tag || seen.has(outbound.tag)) continue;
    seen.add(outbound.tag);
    output.push(outbound);
  }
  return output;
}

function applyGroupRule(groupTag: string, currentTags: string[], rules: SingGroupRule[], nodes: any[], regionTags: string[]): string[] {
  const rule = rules.find((item) => item.tag === groupTag);
  if (!rule) return currentTags;

  const filteredTags = [...(rule.includeGroups || [])];
  if (rule.includeRegions) filteredTags.push(...regionTags);
  if (rule.includeAll) filteredTags.push(...nodes.filter((node) => matchNode(node, rule)).map((node) => node.tag));
  return unique(filteredTags);
}

export function validateGroupRules(rules: SingGroupRule[]): string | null {
  const graph = new Map<string, string[]>();
  for (const rule of rules) graph.set(rule.tag, rule.includeGroups || []);

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(tag: string, path: string[]): string | null {
    if (visiting.has(tag)) return [...path, tag].join(' -> ');
    if (visited.has(tag)) return null;
    visiting.add(tag);
    for (const next of graph.get(tag) || []) {
      if (!graph.has(next)) continue;
      const cycle = visit(next, [...path, tag]);
      if (cycle) return cycle;
    }
    visiting.delete(tag);
    visited.add(tag);
    return null;
  }

  for (const tag of graph.keys()) {
    const cycle = visit(tag, []);
    if (cycle) return cycle;
  }
  return null;
}

function matchNode(node: any, rule: SingGroupRule): boolean {
  if (rule.excludeName && new RegExp(rule.excludeName, 'i').test(node.tag || '')) return false;
  if (rule.excludeTypes?.length && rule.excludeTypes.includes(node.type)) return false;
  return true;
}
