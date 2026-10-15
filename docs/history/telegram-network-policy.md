> 拆仓前 v1 历史记录，仅用于追溯。命令、路径与线上状态不是当前运行说明；新版不提供兼容。参见 [部署说明](../deployment.md) 和 [v2 契约](../protocol.md)。

# Telegram 动态目标策略

更新：2026-10-15。按用户要求取消服务端固定 IP 白名单，仅允许 Telegram 官方公布网段内的公网 IP，端口固定为 443。仓库默认仍关闭中转和公共接入。

## 请求流程

Worker 从固定 HTTPS 地址 [Telegram CIDR](https://core.telegram.org/resources/cidr.txt) 读取 IPv4/IPv6 网段，验证后缓存在当前边缘地点一小时；没有定时任务，在缓存缺失或到期后的请求中自动刷新。抓取限时 5 秒、正文最多 16 KiB、最多 128 个网段，只接受 200，不跟随重定向。不内置旧 IP 或旧网段作为失败回退。

`GET /v1/config` 返回 `targetPolicy: {kind, port, cidrs, updatedAt, expiresAt}`，替代旧的 `targets` 映射。原生客户端按有效策略匹配 TDLib 请求，将字面 IP 编码为 `ip4_<8位小写十六进制>` 或 `ip6_<32位小写十六进制>`。策略到期前 30 秒刷新，合并并发配置请求；Android、iOS 与 Windows 共用此逻辑。

Worker 顺序为：设备/开发鉴权 → v1 参数检查 → 中转开关 → 目标解码与官方策略校验 → WebSocket Upgrade → 公共预算预留 → TCP。服务器独立复验，客户端编码不构成授权。拒绝任意域名、私网、环回、保留地址、IPv4 映射 IPv6、其他端口及官方网段外 IP；目标拒绝返回 403。冷缓存或过期策略刷新失败返回 `503 TELEGRAM_POLICY_UNAVAILABLE` 和 `Retry-After: 60`，不会继续使用过期范围。

## 兼容与运行边界

WebSocket v1 二进制帧、ACK 和窗口未变，但配置结构及目标编码改变，旧客户端必须更新。新 Android 正常应用已安装；Windows 源码已更新，本轮未重建验收旧桌面产物。iOS 共用逻辑通过测试，原生构建仍需 macOS/Xcode。

签名密钥、已有安装凭据、Telegram 会话和片库保持原有存储。设备每日激活次数限制继续取消；接口速率、每设备 1 GiB/全服务 4 GiB 日流量、6 条并发、单连接 64 MiB/15 分钟保持不变。授权成功不代表媒体播放、吞吐或长期稳定性通过。

## 验证与维护

- `worker/`：`npm run format:check`、`npm run check`、`npm test`、`npm run build`；64 项运行时测试覆盖网段解析、缓存刷新、过期/失败关闭、鉴权和预算边界。
- ``：`flutter analyze`、`flutter test`；全量 234 项通过，最终超时调整后的 11 项中转回归通过。
- `npm run test:relay`：临时独立 Worker 入口仅接本机 echo，1 MiB 字节顺序通过；该夹具不代表生产策略允许私网。
- 线上版本 `f89bd7b2-7834-4aba-97ad-998ad7efb75a` 承接 100% 流量。无系统代理配置请求返回 200、14 个官方网段、无固定目标及激活次数项；三个官方目标 MTProto `resPQ` 与 nonce 校验通过，临时探测凭据已撤销。
- Android NE2210 正常应用经默认服务完成手机号 → 验证码 → 两步验证 → `authorizationStateReady`，界面无错误、无目标拒绝。验证信息由用户仅在应用输入；只读诊断不保存输入或会话内容。

当前 Code Review 能力仅支持 PR CI 查询，本次按源码、调用方与 diff 人工审查。未重新验收移动来源保存/重开、播放、Windows 新产物、iOS 原生、16 KiB 系统及远程 CI。官方源或边缘访问异常会影响新连接；应根据 503 与脱敏 `telegram_policy_unavailable` 事件排查，不能改成任意目标放行。

平台依据：[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)、[Node net / BlockList](https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/)、[TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。
