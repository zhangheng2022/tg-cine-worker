# 原服务接管与 v2 发布

目标仍是 Worker `tg-cine-worker` 和域名 `tg-cine.zhangheng.eu.org`。2026-10-15 已获得授权并完成 v2 发布及旧状态清理。后续发布仍需明确部署授权。

## 2026-10-15 取消播放配额（已部署）

用户已确认取消设备/全局日流量、单连接流量与持续时长、设备并发配额，保留鉴权、目标白名单、请求防刷和内存保护。源码已移除配额检查及预留/结算；现有 DeviceSession/ServiceBudget 类、绑定、迁移历史和数据保留，没有重置设备或轮换密钥。客户端配置解析本来就不依赖 limits，无需增加兼容分支。

北京时间 20:26 经用户明确授权，由实际部署配置构建的 Vite 产物发布为 `01368cee-6b77-4aa4-a606-8baed1d5c89c`，承接 100% 流量，替换旧配额版本 `df83ba40-739d-4b55-bb20-64aa1725b8dd`。发布前后绑定完全一致，DeviceSession/ServiceBudget 命名空间 ID 未变，两项 Secret 保留；没有执行 Secret 写入、数据删除或新增迁移。线上 health 正常、v2 config 不再包含 limits、无凭据 tunnel 返回 401；原设备凭据及 Telegram 会话连接成功。构建、dry-run、部署日志和前后版本元数据留在忽略目录 `.cache/deployment/quota-*`。取消配额后，关闭服务开关和撤销凭据只拒绝新连接，持续活跃的旧连接没有固定结束时间；停服操作不能再依赖等待 15 分钟。

旧线上 DEVICE_LIMIT 已用原设备凭据定位：北京时间 18:50:24 停止前次测试，19:06:15（超过最长租约 15 分 30 秒）首连接 101、并发第二条 429 DEVICE_LIMIT；正常关闭首连接后，19:06:18 再开连接为 101。排除此前本机租约未释放占满并发，表明日预算只够预留一条 64 MiB 连接，不够两条；未结算预留仍可能计入旧日账本，不能由此得出实际流量用满 1 GiB。此次正常关闭后预算可复用。证据留在客户端忽略目录 `.cache/verification/relay-limit-after-expiry.json`，未重置远程数据。

本地 67 项 Worker 测试、格式/类型检查、Vite build/dev/preview 检查、构建产物 dry-run，以及客户端 → workerd → TCP 的 1 MiB 联调通过。新增回归覆盖旧满额账本及租约不阻止七条并发连接，持续传输跨过旧 64 MiB/15 分钟边界；保留原鉴权、策略、ACK/队列/超时与关闭回归。Code Review 工具仅支持 PR CI 查询，本地差异采用人工审查。Hono Node 快照不能解析 cloudflare 内建模块，使用 workerd HTTP 验证与 Cloudflare Vitest；未改技能说明。

上线后的 Windows 真实复验使用原设备、Telegram 账号和原选定视频，账号 ready，真实画面、音频输出、前拖/回拖和重开续播位置恢复均有证据；没有 HTTP 429、流量/时长配额断流。四段约 61 秒观察分别缓冲 34.7、29.8、35.2、27.1 秒，持续性测试明确失败，实际听感尚未人工确认。取消配额上线成功不等于播放缓冲已修复。客户端完整记录见其 `docs/flutter-player.md` 最新章节及忽略目录 `.cache/verification/quota-deployed-real/real-library-playback.json`。

## 2026-10-15 首次 v2 发布记录

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

## 后续常规发布（需另行授权）

首次切换和旧状态销毁已完成，上述记录仅供追溯。常规发布不重做解除绑定、删除旧状态或轮换密钥；新的迁移、轮换或远程数据操作需单独明确范围并获得授权。

1. 核对账户、服务名、自定义域名、已部署版本及迁移 tag。确认使用 DeviceSession/ServiceBudget，保留已执行的迁移历史，不新增重置迁移。
2. 运行完整本地检查、dry-run 和配套客户端的跨仓联调，记录两仓 revision。客户端升级恢复和完整播放仍需各自验收，不用接口或握手通过替代。
3. 核对已忽略的 `.cache/deployment/wrangler.public.json`：main 指向本仓 src/index.ts、DO 为现有新类、开关及域名符合目标。在 Vite 构建时选择此源配置，再核对 dist/worker/wrangler.json 中的部署目标及绑定。此文件为本机材料，新检出不能假定已有；缺少时先根据 wrangler.jsonc 和已核实的目标配置准备，不从历史命令猜测线上状态。
4. 仅在获得部署授权后发布已核对的 Vite 产物，沿用现有服务端 Secrets。密钥轮换不属于普通发布步骤；需要轮换时，单独考虑凭据失效范围，Secret 写入本身也必须纳入部署授权。
5. 发布后核实新版本承接流量，检查 health/config、设备注册/刷新/撤销、401/429/503、非法目标拒绝及真实 Telegram 握手；按本次变更范围补充新版客户端验收。

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
