# Hono Worker 架构

Hono 直接注册健康、配置、设备和中转路由。公共路由按 available、bootstrap rate limit、bounded JSON、refresh credential 中间件组织；Hono Context 传递绑定与已验证凭据。无旧 handler 按 pathname 分发的兼容层。

`DeviceSession` 每安装一个 SQLite Durable Object，管理访问/刷新摘要、期限、撤销、并发及日字节量；`ServiceBudget` 只协调全局字节预算，不承担所有设备鉴权。旧注册次数表和兼容列已移除。

`tunnel.ts` 依次鉴权、检查 v2 参数、开关、官方目标策略、Upgrade、预算预留，再调用 `relay.ts`。传输只向通过校验的目标建立 TCP，保留原生 WebSocketPair、二进制数据、ACK、有界窗口、超时及幂等结算。Hono 不负责重写 TCP 传输算法。

`targets.ts` 从固定 Telegram HTTPS CIDR 来源获取策略，在边缘缓存一小时；禁止重定向，5 秒超时、16 KiB 上限。过期或抓取失败拒绝，不回退旧网段或固定目标。

构建使用既有 Wrangler 和 compatibility_date，以本仓锁定运行时为基线；更改日期需单独核对运行行为。日志保留脱敏事件并启用 tracing。源码、生成 Env、运行时测试由同一配置驱动。
