# Cloudflare Workers + Vite 架构

Hono 直接注册健康、配置、设备和中转路由。公共路由按 available、bootstrap rate limit、bounded JSON、refresh credential 中间件组织；Hono Context 传递绑定与已验证凭据。无旧 handler 按 pathname 分发的兼容层。

`DeviceSession` 每安装一个 SQLite Durable Object，管理访问/刷新摘要、期限及撤销。播放路径不再读取或写入额度/租约账本；`ServiceBudget` 的类、绑定及历史数据保留，避免删除已部署命名空间或重置设备凭据。旧注册次数表和兼容列已移除。

`tunnel.ts` 依次鉴权、检查 v2 参数、开关、官方目标策略、Upgrade，再调用 `relay.ts`。传输只向通过校验的目标建立 TCP，保留原生 WebSocketPair、二进制数据、ACK、有界窗口、连接/空闲/ACK 超时及幂等清理。Hono 不负责重写 TCP 传输算法。

`targets.ts` 从固定 Telegram HTTPS CIDR 来源获取策略，在边缘缓存一小时；禁止重定向，5 秒超时、16 KiB 上限。过期或抓取失败拒绝，不回退旧网段或固定目标。

Vite 通过 `@cloudflare/vite-plugin` 在本地 workerd 中开发并构建服务端，Hono 继续负责路由。`vite.config.ts` 将环境命名为 worker，产物及部署配置写入 `dist/worker/`；部署检查读取生成的配置。没有浏览器入口，也不需要 index.html 或 SPA 静态资源。

保留既有 Wrangler 和 compatibility_date，以本仓锁定运行时为基线；更改日期需单独核对运行行为。日志保留脱敏事件并启用 tracing。源码、生成 Env、Cloudflare Vitest 运行时测试由 wrangler.jsonc 驱动；独立 Vitest 配置不叠加开发插件。CI 另外检查 Vite 开发和构建预览的 HTTP 行为，跨仓传输脚本通过 Vite 启动隔离测试 Worker。
