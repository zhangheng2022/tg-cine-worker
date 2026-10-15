> 拆仓前 v1 历史记录，仅用于追溯。命令、路径与线上状态不是当前运行说明；新版不提供兼容。参见 [部署说明](../deployment.md) 和 [v2 契约](../protocol.md)。

# 默认服务与公共配置

更新：2026-10-15。默认地址为 `https://tg-cine.zhangheng.eu.org`；用户无需填写地址、共享令牌或邀请码。仓库配置保持服务默认关闭，目标按 Telegram 官方 CIDR 自动更新，线上启用使用独立部署配置。

## 接入与状态

1. 客户端从 `/v1/config` 获取协议版本、有效期一小时的官方目标策略 `targetPolicy` 和公开额度；接口不返回任何密钥、Telegram 应用标识或用户数据。
2. 首次使用调用 `POST /v1/devices`，自动获得独立安装凭据。访问凭据有效 10 分钟，仅在内存；30 天刷新凭据按服务域名/端口隔离保存在系统安全存储。
3. 原生桥接在每次建立 WSS 连接前取有效访问凭据；并发刷新合并为一次。凭据仅放 Authorization，不进入 URL。
4. 设置页分别展示默认服务及 Telegram 状态。凭据被拒绝时不自动创建新安装；用户按「重新连接」后清理已失效的凭据并重新启用，保留本机 Telegram 会话与片库。
5. 普通关闭保留凭据。显式退出登录先注销 Telegram，再尝试撤销设备凭据；撤销失败仍关闭客户端并报告错误。撤销阻止新的访问和刷新，已建立连接最迟在 15 分钟上限后结束。

设备凭据只授权使用中转，不验证 Telegram 身份，也不是设备防篡改证明；Telegram 授权仍由用户在客户端完成。协议不上传账号 ID、频道、媒体信息、会话数据库或密码；中转传输的是 MTProto 字节。

## Worker 与配额

`PublicSession` 每安装一个 SQLite Durable Object，保存凭据摘要、期限、撤销状态、连接预留与用量；`PublicBudget` 只协调全局流量预算，不代理所有设备鉴权。令牌先验证服务端 HMAC，再访问安装对象，伪造 ID 不能创建任意对象。

| 限制           | 当前策略                                                                |
| -------------- | ----------------------------------------------------------------------- |
| 每设备日字节量 | 1 GiB，上下行合计                                                       |
| 全服务日字节量 | 4 GiB                                                                   |
| 每设备并发     | 6 条                                                                    |
| 单连接         | 64 MiB / 15 分钟，沿用既有传输边界                                      |
| 新设备激活     | 不设同地址或全服务每日次数上限，保留接口速率限制                        |
| 接口速率       | 每安装 120 次/分钟；未授权配置/激活阶段按地址限制，同一网络可能共享额度 |

字节日额度按 UTC 重置。连接前先预留 64 MiB；正常关闭按实际计数退还余量，结算幂等；异常/未结算预留保留满额，过期只释放并发槽位。跨对象分配失败采用保守计费，避免进程损失导致超额。

流量额度按协议计数，不等于 Cloudflare 账单金额上限。接口速率在 Cloudflare 地点内近似执行；持久字节额度由 Durable Objects 控制。激活接口不再写入日注册次数或每日地址计数；旧存储结构保留兼容，流量预算操作仍清理过期历史记录，未重置现有流量或凭据。凭据原文不写服务数据库。没有将这些措施计为完整反滥用或大规模压测验收。

公开模式拒绝共享开发 `RELAY_TOKEN`，凭据与官方网段校验先于 TCP 连接，格式错误或范围外请求不预留传输额；策略取得失败返回 503，详见 [动态目标策略](telegram-network-policy.md)。`PUBLIC_SIGNING_KEY` 仅为 Worker Secret；更换它会使已有安装凭据失效。API 输入/响应有大小界限，不跟随客户端配置或凭据请求的重定向。

## 构建

`dart run tool/prepare_public_config.dart <project-api-env>` 生成已忽略、受权限保护的 `.cache/deployment/flutter-public-defines.json`，只包含项目 `TG_CINE_API_ID` / `TG_CINE_API_HASH`，不包含中转令牌、用户会话或本机路径。应用标识须使用项目自己的 Telegram 申请信息；客户端需要携带它进行 Telegram 初始化，不能把它作为服务端鉴权秘密。

Android/iOS 共享原生接入、刷新、安全存储和界面逻辑；按原有移动原生构建/校验流程打包 TDLib。Windows 的已核验产物由准备工具复制到已忽略的 `windows/TDLib/tdjson.dll`，CMake 再校验 SHA256 并随应用打包。构建命令示例：`flutter build apk --debug --dart-define-from-file=../.cache/deployment/flutter-public-defines.json`。

为保留当前 Windows 调试数据，Debug 可额外传 `TG_CINE_TELEGRAM_CONFIG=<已有本机配置路径>` 与 `TG_CINE_USE_DEFAULT_SERVICE=true`。此分支只复用本机库、应用标识和会话路径，改从默认服务获取独立凭据，不读取开发中转令牌。它不是可分发的构建输入；公开客户端使用应用数据目录。Android/iOS 的原有公开构建拒绝开发配置规则保留。

## 当前动态策略与登录结果

2026-10-15 取消服务端固定 IP 列表，改为自动获取 Telegram 官方 CIDR，冷缓存或到期后按需刷新。线上版本 `f89bd7b2-7834-4aba-97ad-998ad7efb75a` 承接 100% 流量，配置返回 14 条官方网段；设备激活次数上限仍已取消，其余预算不变。新版正常 Android 应用已完成真实登录且无界面错误和目标拒绝。234 项 Flutter、64 项 Worker 测试及 1 MiB 本地中转联调通过，详见 [策略契约与兼容边界](telegram-network-policy.md)。以下为逐轮历史记录，固定目标和待登录状态已被本节取代。

## 验证记录（历史）

全量 222 项 Flutter、58 项 Worker 测试与相关检查通过。真实 workerd/TCP 的旧 1 MiB 回环仍通过；公共接口覆盖配置脱敏、签发/刷新/撤销、篡改与共享令牌拒绝、接口限流及无每日激活上限、设备与全局额度、并发及幂等结算。

Android NE2210 真机与 Windows 的本地协议替身通过真实系统安全存储的注册、重开刷新及撤销，隔离键按本机测试地址创建并清理。48 张 Windows 原生 Flutter 平台变体截图覆盖连接成功、不可用及重新启用；不包含真实凭据或会话。

线上版本 `832a1d98-b3ff-44e4-b8e3-82d0b8323ede` 已部署到原域名。显式无系统代理 HTTP 验证配置 `200`、注册 `201`、刷新 `200`、旧访问凭据拒绝 `401`、有效凭据缺少 Upgrade `426`、撤销 `204`，撤销后的访问及刷新均为 `401`。访问凭据不能用于刷新。初次 Python 默认 User-Agent 请求返回非 JSON `403`；TG Cine 和 Dart User-Agent 复核均为 `200`，没有修改网站防护设置。

公共凭据下真实 TDLib 五个 DC 临时密钥握手通过，复核耗时 2217–3093 ms；首轮 DC5 未通过，未将首轮计为全部成功。Windows 普通应用 Debug 入口已用默认服务凭据恢复真实登录：`defaultService=true`、`relayReady=true`、Telegram `ready`，原 25 条媒体及已选来源保留，无错误；没有重新导入或读取视频。Windows 打包 DLL 的哈希与固定产物一致；Android 正常入口 APK 已恢复安装并启动，Web 模板构建通过。

Android TDLib 原生库已交付，2026-10-15 真机默认服务下手机号、验证码及两步验证均通过，最终状态 ready。移动真实来源保存/重开及导入、iOS 原生、Web 业务、播放稳定性、远程 CI、大规模负载和公开商店发行未验收。用户已停止播放排查，本轮不恢复。初始额度适用于受控开放，不代表可承载所有用户的影视流量；额度耗尽会拒绝新连接。

### Windows 连接入口修复

2026-10-14 用户报告点击连接无反馈。运行时确认按钮调用已触发，但 TDLib 停在 `authorizationStateLoggingOut`，桥接拒绝未映射的 `149.154.175.55:443`。核对当日 Telegram 官方 CIDR 后，只增加该固定目标；线上版本更新为 `c00f6978-5de0-47ab-aaaa-e02432ae3abe`，公开配置已核实包含 11 个目标，未开放整个网段。

Windows 启动脚本改为默认服务，取消对开发中转配置/令牌文件的启动依赖。Android/iOS/Windows 共用仓库在重新连接时等待未完成的原生退出，然后最多重开一次；显式退出先等待原生关闭，再撤销中转凭据。等待上限为 45 秒，意外关闭和清理失败不能再吞掉界面错误；不删除媒体数据库。

修正后 Windows 实际状态为 `authorizationStateWaitPhoneNumber`、界面 `phone`、无错误且无被拒目标，用户已确认看到手机号输入框。230 项 Flutter 测试和静态分析通过，Windows 运行及 Android Debug APK 构建通过；新增按钮调用/失败/重试及退出顺序、恢复用例。此记录不表示本轮已经再次完成账号授权，iOS 原生和移动真实登录仍待验收。

### Android 原生交付与默认接入修复

2026-10-14 查明手机安装包没有 `libtdjson.so`。现已从同一固定 TDLib 提交构建并打包 arm64-v8a、x86_64；携带 Telegram 应用标识的构建缺少库时直接失败，iOS 对应增加 XCFramework 检查。原生来源、哈希及命令见 [移动原生记录](https://github.com/zhangheng2022/tg-cine/blob/master/docs/mobile-native.md)。

模拟器接入时线上返回 `429 ENROLLMENT_LIMIT`：同一网络此前的多设备测试已耗尽每日 3 次激活额度。现将同地址上限调整为 8，全局 32、设备 1 GiB、服务 4 GiB、并发及速率限制保持不变，未重置持久计数。线上版本为 `253abd13-434d-4883-b23c-f81eea6193cd`，公开配置包含 11 个固定目标及 `addressEnrollments=8`。

Android x86_64 模拟器和 NE2210 真机均通过实际 TDLib 加载、初始状态及正常关闭；真机另通过默认凭据、启用的回环代理、原生 `pingProxy` 及真实 Application 手机号表单，未提交手机号、验证码或密码。全量 230 项 Flutter、58 项 Worker 测试及相关检查通过。该结果不表示已完成真实账号登录、来源读取或播放。

实现依据：[Durable Objects SQLite 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[RPC 调用](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)、[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[速率限制](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[Telegram 应用标识](https://core.telegram.org/api/obtaining_api_id)。

### 取消每日设备激活次数限制

2026-10-14 按用户要求删除同地址每日 8 次及全服务每日 32 次限制。签发不再查询或更新全局注册预算，公开配置移除 `enrollments` 与 `addressEnrollments`；现有客户端不依赖这两个字段，无需重装。保留设备鉴权、刷新/撤销、固定目标、接口速率、并发及字节预算，不重置设备凭据或既有流量。

58 项 Worker 测试、类型、格式及 dry-run 通过；回归覆盖同地址连续 33 次激活、旧全局计数达到 32 时仍可签发，并确认原字节预算不变。取消次数上限可能增加安装对象及凭据存储请求，尚未进行大规模负载/费用验收。

线上版本 `440cabc4-526d-4955-9a9e-9739ccc6dbf1` 已核实承接 100% 流量；无系统代理接口验证配置 `200`、激活 `201`、刷新 `200`、旧访问凭据 `401`、有效凭据缺 Upgrade `426`、撤销 `204`、撤销后刷新 `401`，测试凭据已撤销。当前 Code Review 工具只支持 PR CI 查询，本次基于源码与差异手动审查；未重复手机号或播放测试。

### Android 手机号提交连接失败

2026-10-15 手机提交手机号后出现通用连接错误。运行时核实默认凭据正常，但 TDLib 请求的 `91.108.56.164:443` 不在桥接目标映射中，数据尚未到达 Worker。经 [官方 CIDR](https://core.telegram.org/resources/cidr.txt) 核验后，在部署配置只补齐这个固定目标，现为 12 个；不开放整个网段，仓库仍默认关闭、空白名单。

当时版本 `fe375f67-d5b4-4ca8-970d-29071166bc0d` 承接 100% 流量，配置可读、激活次数上限仍已取消；新目标独立 MTProto 握手通过。手机保留会话数据重开后，已使用新配置并出现正常双向数据，没有目标拒绝、容量拒绝或界面错误。完整手机号提交至验证码步骤仍待用户重试，测试没有代填或提交账号信息。
