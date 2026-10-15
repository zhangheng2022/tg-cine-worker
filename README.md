# TG Cine Worker

TG Cine 默认中转服务，使用 Cloudflare Workers + Vite，Hono 负责 TypeScript API 路由。客户端独立维护于 [tg-cine](https://github.com/zhangheng2022/tg-cine)，本仓库不包含 Flutter 源码。

只提供 v2：公开配置、设备激活/刷新/撤销，以及经过鉴权和官方 Telegram 动态 CIDR 校验的 WSS → TCP 中转。不读取 Telegram 会话、账号密码或媒体数据库。不提供 v1 兼容。

## 开发

Node.js 24，使用锁文件安装：

```powershell
npm ci
npm run dev
npm run format:check
npm run check
npm test
npm run build
npm run test:vite
npm run deploy:dry-run
```

`dev` 使用 Vite 和 `@cloudflare/vite-plugin`，在本地 workerd 中运行；`build` 生成 `dist/worker/`，不部署。`preview` 重新构建并预览产物，`test:vite` 检查开发与已构建产物的 HTTP 行为，`deploy:dry-run` 校验已构建的部署包。仓库默认关闭中转和公共接入。开发时从 `.dev.vars.example` 准备已忽略的本机配置；真实密钥不进入 Git 或日志。

构建配置见 `vite.config.ts`，绑定及运行时配置仍由 `wrangler.jsonc` 管理，部署使用 Vite 生成的 `dist/worker/wrangler.json`。配置依据 [Cloudflare Vite 插件指南](https://developers.cloudflare.com/workers/vite-plugin/get-started/)。插件锁定为与本仓 Wrangler 匹配的版本，升级时一起检查 peer dependencies。

Hono CLI 用于路由和 HTTP 检查，例如 `npx hono routes`、`npx hono request /health --runtime workerd`；DO、TCP 和 WebSocket 行为仍用 Cloudflare Vitest 运行时及真实回环检查。

## 跨仓联调

先在客户端根目录执行 `flutter pub get`，再在本仓执行：

```powershell
npm run test:relay -- ../tg-cine
```

脚本要求显式客户端目录，通过同一 Vite 配置启动临时 workerd/TCP echo，核对 Dart 桥接的 1 MiB 顺序及资源关闭；不连接线上，也不放宽生产目标策略。GitHub 手工联调工作流要求完整客户端提交 SHA。

## 文档

- [架构](docs/architecture.md)、[v2 契约](docs/protocol.md)
- [部署与旧状态清理](docs/deployment.md)：承接原 Worker/域名，删除旧 DO 数据，必须另行授权部署
- [拆仓前历史](docs/history/worker-deployment.md)：仅作追溯，不作为当前操作指南

本仓从首次提交初始化，不携带客户端或旧 Worker Git 历史。Cloudflare 全部 17 个技能、Hono 与 grill-me 保留在 `.agents/skills/`，锁文件独立维护。
