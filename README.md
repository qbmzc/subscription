# subscription

Cloudflare Worker 订阅管理面板，用一个 KV 存储 sing-box 与 mihomo 的模板、订阅集、合并结果和面板配置。

## sing-box 1.14.4 设备订阅

新增功能通过 **独立设备链接** 使用。原有普通订阅继续使用原来的模板、覆写、节点名称和缓存，下载时会处理平台专属选项；新增设备及修改设备分流规则不会重新生成普通订阅缓存。先在测试设备验证，再自行决定是否替换其订阅链接。本机现有代理无需切换。

在面板的 **覆写与分组** 页面：

1. 设置公司 DNS、公司域名、WireGuard 目标网段和 AI 出口。默认公司 DNS 为 `192.168.99.99`，公司域名为 `test.com`、`taimei.com`，WireGuard 目标为 `10.0.0.0/24`。域名按后缀匹配，包含子域名。清空公司域名可停用公司 DNS 分流。
2. 新增设备并选择 Android、iOS、macOS、Windows 或 Linux。WireGuard 可暂时留空，先检查其他功能。
3. 填入该设备的 WireGuard endpoint JSON，保存后复制设备订阅链接。每台设备使用各自的地址、私钥和服务器端 peer；无需把真实密钥写进源码。
4. 将下载的 JSON 用目标内核执行 `sing-box check -c config.json`。该命令只校验配置。各平台实际 VPN、路由和连通性仍需在测试设备验证。

WireGuard endpoint 示例（替换所有示例值后保存）：

```json
{
  "type": "wireguard",
  "address": ["10.0.0.2/32"],
  "private_key": "设备自己的 Base64 私钥",
  "peers": [
    {
      "address": "服务器公网 IP 或域名",
      "port": 51820,
      "public_key": "服务器的 Base64 公钥",
      "allowed_ips": ["10.0.0.0/24"],
      "persistent_keepalive_interval": 25
    }
  ]
}
```

设备输出固定使用 `wg-private` 作为 endpoint 标签，使用用户态接口和 `direct` 建立 WireGuard 底层连接。规则保留模板前面的嗅探、DNS 劫持，再插入 WireGuard 网段、公司域名直连和 AI 域名路由，优先于通用私网直连规则。公司域名由 `192.168.99.99` 直连解析；离开公司后仍需有能访问公司 DNS 和服务的网络路径。

设备配置会迁移旧默认模板的 `block` 出站与“全球拦截”分组为 `reject` 规则动作；普通订阅保持原样。设备节点名称使用 `订阅名称 | 原节点名称`，保留不同订阅的同名节点，并更新节点间的 `detour` 引用。AI 需要固定出口 IP 时请选择具体节点，自动测速组可能切换节点。`auto_redirect` 仅在 Linux 设备保留，其他平台移除；设备的 mixed 代理只监听 `127.0.0.1`。

设备订阅链接形如：

```text
/sub?device=<设备ID>&token=<该设备令牌>
```

设备平台决定输出格式，不依赖 User-Agent，也不会因 `target=mihomo` 输出另一种配置。设备令牌只能下载对应设备配置；重置令牌或删除设备即可撤销旧链接。设备 endpoint（含私钥）保存在当前 Worker 的 KV 中，管理员可在设备表单中编辑；该版本没有对 KV 中的私钥额外加密。设备链接包含访问凭据，请勿公开。

## 订阅下载鉴权

设备链接始终要求独立令牌。普通 sing-box 和 mihomo 链接的下载令牌在 **配置** 页面手动启用，独立于管理员密码、外部 API Token 和设备令牌。留空时保留现有普通订阅的公开访问方式。

**启用或更换普通下载令牌会使原链接失效。** 请先复制面板上新生成的链接，再更新相关客户端。支持 `?token=<下载令牌>` 或 `Authorization: Bearer <下载令牌>`；下载响应使用 `Cache-Control: private, no-store`。

## 部署

- fork本项目
- Cloudflare控制台,存储与数据库/Workers KV/创建KV命名空间 
- 修改wrangler.toml中 kv_namespaces/id 为 KV/id 
- 创建Workers应用程序,连接你的仓库即可

## 重要安全事项

部署完成后：

1. 默认禁用admin/admin登录。
- 在 Workers项目控制台,设置中添加环境变量 `ADMIN_PASSWORD` `ADMIN_USER`

2. 登录面板后进入 `配置` 页面，修改面板路径、订阅路径、外部 API 路径和 API Token。
- 不设置token ,默认禁用API
  
3. 不建议使用默认 /sub 路径作为下载链接,务必修改

## 默认模板

内置两个模板：

- `template/template.json`：sing-box 默认模板
- `template/template.yaml`：mihomo 默认模板

首次使用时会从这两个模板初始化。mihomo 模板中的 `proxy-providers` 会被抽离为面板可管理的订阅集；下载 mihomo 配置时再写回 `proxy-providers`。

## 下载逻辑与 UA 自动识别

默认订阅路径是 `/sub`，可在 `配置` 页面修改。

同一个订阅地址会根据 User-Agent 自动返回不同格式：

- mihomo / Clash 类 UA：返回 YAML
- SFA / Android / sing-box Android 类 UA：返回 Android sing-box JSON
- 其他 UA：返回普通 sing-box JSON

也可以用参数强制指定：

```text
/sub?target=mihomo
/sub?target=sing-box
/sub?target=sing-box-android
```

普通 sing-box 下载也会按 User-Agent 识别平台。Mac、Windows、Android、iOS 和未识别平台的输出会移除 Linux 专属的 `auto_redirect`，无需清理旧 KV 缓存。可使用 `&platform=macos` 显式指定 Mac；Linux 客户端未携带系统信息时，可使用 `/sub?target=sing-box&platform=linux` 保留该选项。设备专用链接以设备设置中的平台为准。

面板顶部的 `auto`、`sing-box`、`mihomo` 按钮只复制链接，不直接下载。

## sing-box 合并逻辑

sing-box 不直接使用订阅集格式。Worker 会在添加或更新 sing-box 订阅集时拉取远程配置，将其中的节点提取出来，与 sing-box 模板合并，并把完整结果缓存到 KV。

下载时不会每次重新合并，而是直接返回已缓存的完整配置。

合并时会：

- 提取各订阅集中的节点出站。
- 根据节点名称识别国家/地区，动态生成地区分组。
- 将地区分组插入模板中已有的分组。
- 根据 Android / 其他平台覆写生成两份 sing-box 配置。

高级页 `覆写与分组` 可以配置：

- Android / 其他平台覆写
- 每个模板分组是否包含所有节点
- 是否包含国家分组
- 排除指定协议
- 按名称关键字或正则排除节点

覆写规则中对象会递归合并，数组会整体替换。

## mihomo 逻辑

mihomo 只管理 `proxy-providers` 订阅集，不会自动修改模板里的 `proxy-groups` 分组策略。

添加 mihomo 订阅集后会：

1. 写入 mihomo 的 `proxy-providers`。
2. 拉取该 YAML。
3. 提取其中的 `proxies`。
4. 尝试翻译为 sing-box 节点。
5. 同步保存为一个 sing-box 订阅集。

也就是说，mihomo 侧如果希望这些 provider 被具体分组使用，需要手动修改 mihomo 模板里的 `proxy-groups`,默认模板大多数分组已设置 `include-all: true`  。

当前 mihomo 到 sing-box 翻译器支持基础协议：

- VMess
- VLESS
- Trojan
- anytls
- Hysteria / Hysteria2
- TUIC

不支持的协议会跳过；如果没有任何可支持节点，会返回错误。

## 外部 API
主要用途是在脚本配置完节点后自动合并订阅,无需再手动通过面板添加

外部 API 路径和 Token 在 `配置` 页面设置。默认路径是：

```text
/external-api
```

如果未设置 API Token，外部 API 默认禁用。

认证方式支持：

```http
Authorization: Bearer <token>
X-API-Token: <token>
```

也支持 `?token=<token>`。

### 添加订阅集

默认添加 mihomo yaml订阅集。外部 API 默认采用宽松模式：先保存订阅名称和 URL，清理同名旧 sing-box 订阅内容，并返回待拉取状态，不会因为 DNS 尚未生效或远程 URL 暂时不可访问而添加失败。之后可在面板点击更新完成拉取和翻译。

```bash
curl -X POST "https://example.com/external-api" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"provider-name","url":"https://example.com/provider.yaml"}'
```

如需恢复同步校验，添加 `strict: true` 或 `deferFetch: false`。严格模式会立即拉取远程内容，失败时直接返回错误。

### 单独添加 mihomo 订阅集

```json
{
  "type": "mihomo",
  "name": "provider-name",
  "url": "https://example.com/provider.yaml"
}
```

### 单独添加 sing-box 订阅集

```json
{
  "type": "sing-box",
  "name": "sing-name",
  "url": "https://example.com/sing-box.json"
}
```
