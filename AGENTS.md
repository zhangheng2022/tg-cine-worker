# Worker 贡献指南

仅维护 Cloudflare Workers + Vite，API 使用 TypeScript / Hono，不放入 Flutter 源码。客户端仓库为 tg-cine；跨仓联调必须明确客户端目录或完整 revision。

## 结构与风格

src/index.ts 组装 Hono 路由与错误处理；public_service.ts 定义公共接口和请求中间件；public_access.ts 定义 DeviceSession / ServiceBudget；tunnel.ts 编排鉴权、目标校验与额度预留；relay.ts 负责 TCP/WSS 流控和清理；targets.ts 获取官方动态策略。按现有职责组织，不增加空 controller/service/repository 层。

使用 Prettier（tab、单引号、分号、140 字符行宽），Node.js 24，npm 锁文件。Env 由 Wrangler 生成，不手写重复类型。

## 检查

依次运行 npm ci、npm run format:check、npm run check、npm test、npm run build、npm run test:vite、npm run deploy:dry-run。dev/build/preview 使用 Cloudflare Vite 插件，build 不部署；dry-run 读取 dist/worker/wrangler.json，不能绕过 Vite 从源码重新打包。协议、传输或运行工具链变更另运行 npm run test:relay -- <client-checkout>，协议变更同步客户端契约测试。测试覆盖鉴权、失败路径、额度与资源清理。

## 技能与审查

按任务读取 hono、workers-best-practices、wrangler、durable-objects 的 SKILL.md；Cloudflare 其余技能全部保留，按需使用。Hono CLI 用于路由和 HTTP 检查，不能代替 Workers 运行时、WebSocket 与 TCP 联调。

grill-me 委托环境中的 grilling 技能，仅用户明确调用时开展质询；先给方案不授权实施。功能、安全、架构改动检查后用可用 Code Review 审查差异，能力不足则注明并人工审查。Graphify 只在明确请求更新时重建，产物在已忽略的 graphify-out/；普通查询先核对图和源码，不自动开 hooks/watch。

## 安全与发布

仅 v2，不保留旧协议、旧客户端、旧凭据或旧状态兼容。已批准的状态清理通过部署迁移删除 PublicSession/PublicBudget 并创建新类；本地改配置不等于线上已执行。

只允许动态获取的 Telegram 官方公网 CIDR、固定端口 443。抓取/过期失败拒绝，不回退固定 IP 或任意主机。鉴权、目标校验、Upgrade 和预算预留先于 TCP。保留有界帧/窗口/时长、异常清理和保守额度结算。

Secrets、本机配置和日志不提交，不输出凭据。仓库默认服务关闭。部署、Secret 写入和远程状态删除均须明确部署授权。承接既有服务时以 docs/deployment.md 为准，不执行历史文档中的旧命令。中文提交；公开前检查 Git 内容没有敏感材料。
