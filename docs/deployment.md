# 原服务接管与 v2 发布

目标仍是 Worker `tg-cine-worker` 和域名 `tg-cine.zhangheng.eu.org`。2026-10-15 已获得授权并完成 v2 发布及旧状态清理。后续发布仍需明确部署授权。

## 本次发布记录

- 客户端 [PR #1](https://github.com/zhangheng2022/tg-cine/pull/1) 与本仓 [PR #1](https://github.com/zhangheng2022/tg-cine-worker/pull/1) 均已合并；服务端源码提交为 `643200804c422e44e6f2e9b6c5843231467d012e`。
- 线上版本：`df83ba40-739d-4b55-bb20-64aa1725b8dd`，由实际部署配置的 Vite 产物发布，原 Worker 和自定义域名保持不变。
- 先关闭旧服务的新连接，等待 15 分钟连接上限及 30 秒余量，再解除旧 DO 绑定。直接复用绑定名同时删除旧类曾被 Cloudflare 以 `10061` 拒绝；先解除绑定后，重置迁移成功。
- `PublicSession` / `PublicBudget` 旧命名空间及数据已删除，`DeviceSession` / `ServiceBudget` 使用新的命名空间；两项服务端密钥已轮换，旧目标配置 `RELAY_TARGETS` 已移除。
- 线上 14 项接口检查通过，包括 v2 配置、激活、刷新、旧凭据拒绝、非法目标拒绝和撤销；客户端真实 PublicRelayService / RelayBridge 与原生 TDLib 的 DC1–DC5 握手通过。测试凭据已撤销，本地旧密钥已删除。
- Android Debug APK 和 Windows Release 已使用公开构建参数生成；未安装覆盖设备，未读取或修改既有 Telegram 会话、媒体库或观看记录。整部影片播放及真机升级后的数据恢复尚未验收。

部署最初存在短暂边缘传播不一致；上述检查均在 v2 稳定后重新通过。接口及握手通过不等于持续播放或所有网络环境可用。

## 配置与状态

`wrangler.jsonc` 默认关闭中转与公共服务。保留原迁移 tag `public-access-v1` 仅供 Cloudflare 识别既有命名空间；随后 `hono-v2-reset` 删除 PublicSession/PublicBudget 及全部旧数据，并建立 DeviceSession/ServiceBudget。这不是数据兼容或迁移复制，旧设备凭据、配额及预留不保留。

删除命名空间不可通过普通代码回滚恢复；新版状态启用后只能向前修复。不要部署历史目录里的旧配置。Cloudflare 迁移说明：https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ 。

## 发布步骤

1. 核对账户、服务名、自定义域名和当前迁移 tag，检查是否有其他 Worker 绑定旧 DO。准备新版客户端，并告知旧版将不可用。
2. 运行完整本地检查、dry-run 和新版跨仓联调。首次切换时先用原代码关闭新连接，等待旧连接最长 15 分钟及传播余量，再用维护版本移除旧 DO 绑定、保留原迁移 tag 和类导出；最后部署包含删除旧类和创建新类的 v2 产物。不要在旧绑定仍存在时直接复用同名绑定完成删除迁移。
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

实际部署配置与服务端操作材料位于本仓忽略目录，保留权限保护。当前密钥存放于受保护的 `.cache/deployment/v2-secrets.json`，不提交；旧密钥与临时验收凭据已清理。客户端构建输入、Telegram 会话、片库、TDLib 留客户端。历史验收记录位于 docs/history/，不是本版上线证据。
