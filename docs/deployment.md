# 原服务接管与 v2 发布

目标仍是 Worker `tg-cine-worker` 和域名 `tg-cine.zhangheng.eu.org`。本轮拆仓不部署，也未清理远程状态。以下步骤只能在获得明确部署授权后执行。

## 配置与状态

`wrangler.jsonc` 默认关闭中转与公共服务。保留原迁移 tag `public-access-v1` 仅供 Cloudflare 识别既有命名空间；随后 `hono-v2-reset` 删除 PublicSession/PublicBudget 及全部旧数据，并建立 DeviceSession/ServiceBudget。这不是数据兼容或迁移复制，旧设备凭据、配额及预留不保留。

删除命名空间不可通过普通代码回滚恢复；新版状态启用后只能向前修复。不要部署历史目录里的旧配置。Cloudflare 迁移说明：https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ 。

## 发布步骤

1. 核对账户、服务名、自定义域名和当前迁移 tag，检查是否有其他 Worker 绑定旧 DO。准备新版客户端，并告知旧版将不可用。
2. 运行完整本地检查、dry-run 和新版跨仓联调。部署前先停止新连接，等待旧连接结束后再执行破坏性迁移。
3. 使用已忽略的 `.cache/deployment/wrangler.public.json`（本次准备的新版配置），确认 main 指向新仓 src/index.ts、DO 为新类、两个开关开启、域名绑定正确。在 Vite 构建时选择此源配置，再核对 dist/worker/wrangler.json 中的部署目标及绑定。
4. 生成新的 PUBLIC_SIGNING_KEY 和私有开发 RELAY_TOKEN，使用受保护文件或 Wrangler 输入传入，不打印值；不复用旧签名材料。Secret 写入本身可能发布版本，必须纳入同一次授权操作。再执行含状态销毁迁移的部署。
5. 核实新版本承接流量，检查 health/config、设备注册/刷新/撤销、401/429/503 失败路径、目标拒绝及真实 Telegram 握手；使用新版客户端确认原 Telegram 会话和片库仍可恢复。

运行前再次确认使用新版配置：

```powershell
$env:CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = '.cache/deployment/wrangler.public.json'
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Vite build failed' }
  npm run deploy:dry-run
  if ($LASTEXITCODE -ne 0) { throw 'Deployment dry-run failed' }
} finally {
  Remove-Item Env:CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
}
```

dry-run 不会部署或删除旧 DO。正式 deploy 需另行授权，并使用 `npx wrangler deploy --config dist/worker/wrangler.json` 部署刚核对的产物；不要再传源配置，否则会绕过 Vite 构建。环境及目标在构建时确定，部署时不能靠 `--env` 切换。默认 `npm run build` 或 `npm run preview` 会覆盖该目录，正式发布前须重新按目标配置构建和核验。不能从 dry-run 成功推断线上迁移成功。参见 [Vite 配置选择](https://developers.cloudflare.com/workers/vite-plugin/reference/api/)。

## 本地资料

实际部署配置与服务端旧操作材料按所有权移到本仓忽略目录，保留权限保护。旧密钥只用于核对切换前资源，正式切换后删除，不提交。客户端构建输入、Telegram 会话、片库、TDLib 留客户端。历史验收记录位于 docs/history/，不是本版上线证据。
