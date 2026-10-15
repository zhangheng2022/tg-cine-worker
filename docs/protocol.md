# TG Cine v2 契约

仅提供本版本，v1 路由返回 404。客户端仓库 tg-cine 与本仓 v2 同步发布；不自动探测或回退旧协议。

| 方法 | 路径                      | 结果                                                         |
| ---- | ------------------------- | ------------------------------------------------------------ |
| GET  | /health                   | service、status、protocolVersion=2、capabilities.tunnel      |
| GET  | /v2/config                | protocolVersion=2、同源 wss relay、targetPolicy、公开 limits |
| POST | /v2/devices               | 201，accessToken、refreshToken、expiresAt                    |
| POST | /v2/devices/refresh       | 200，accessToken、expiresAt；旧访问凭据立即失效              |
| POST | /v2/devices/revoke        | 204；阻止新访问/刷新，已有连接按连接上限结束                 |
| GET  | /v2/tunnel?v=2&target=... | 经校验后 101 WebSocket                                       |

公共 POST 必须是 application/json 的空对象，最多 1 KiB，拒绝额外字段和查询参数。配置和注册按 CF-Connecting-IP 限速；刷新与访问按安装 ID 限速。凭据通过 Authorization: Bearer 发送，不进入 URL。访问凭据 10 分钟，刷新凭据 30 天；令牌是带 HMAC 的不透明安装凭据，不是 Telegram 身份。

错误为 `{ "error": { "code": "..." } }`，401 表示凭据错误，429 表示速率/额度，503 表示服务/策略不可用；接口响应 no-store。目标策略失败为 TELEGRAM_POLICY_UNAVAILABLE 并带 Retry-After: 60。关闭的私有传输返回 501，缺少 Upgrade 返回 426。

`targetPolicy` 包含 kind=telegram-cidr、port=443、cidrs、updatedAt、expiresAt（Unix 毫秒）。目标只接受 ip4_ 加 8 位小写十六进制或 ip6_ 加 32 位小写十六进制。只允许公网且属于有效官方 CIDR；私网、环回、保留地址、IPv4-mapped IPv6 和任意域名均拒绝。

## WebSocket 与限额

双方使用二进制帧；文本帧 `ACK` 按发送顺序确认一个数据帧，ACK 本身不再确认；其他文本帧或无对应数据的 ACK 拒绝。单帧最多 64 KiB，待写队列和下行窗口最多 256 KiB，下行最多 64 帧；最老未确认帧、空闲超时均 30 秒，TCP 连接超时 5 秒。

每连接上下行合计 64 MiB、最长 15 分钟。每设备最多 6 条并发、1 GiB/UTC 日，全服务 4 GiB/UTC 日。连接前预留，正常关闭按实际计数幂等结算；未结算预留保守计满。没有每日设备激活次数限制，仍有接口速率限制。协议流量预算不是 Cloudflare 账单上限。

## 证据

Worker 运行时测试覆盖鉴权、策略、配额与异常关闭；跨仓脚本验证真实本地 Dart/workerd/TCP 数据。它们不证明生产 Telegram 连接或完整电影播放。
