> 拆仓前 v1 历史记录，仅用于追溯。命令、路径与线上状态不是当前运行说明；新版不提供兼容。参见 [部署说明](../deployment.md) 和 [v2 契约](../protocol.md)。

# Worker 架构

`worker/` 与 `` 并列，使用官方 Worker-only TypeScript 模板。仓库默认关闭中转及公共接入；获授权的线上版本启用独立设备凭据及 Telegram 官方动态网段。公共接口、协议握手、Windows 原会话恢复及 Android 真机完整授权已验证，移动来源恢复及播放仍待验收。见 [默认服务](public-service.md) 与 [部署记录](worker-deployment.md)。

## 模块与调用方向

```text
index.ts   方法与路由识别、健康检查
  public_service.ts  公开配置、签发/刷新/撤销、签名与速率校验
    public_access.ts  每安装 PublicSession、全局 PublicBudget 的 SQLite 持久额度
  tunnel.ts   开发/公共鉴权 → readTargetId → 开关 → resolveTarget → Upgrade → 公共额度预留
    relay.ts   已校验目标 TCP 连接、WebSocket 转发、流控与清理
auth.ts       私有开发 Bearer 凭据校验（公共模式拒绝共享令牌）
protocol.ts   协议版本、查询参数和脱敏错误
targets.ts    官方 CIDR 获取/缓存、IP 解码与目标校验
test/         Vitest Workers 运行时测试
scripts/verify-local-relay.mjs   Dart / workerd / TCP 联调
```

采用原生 `fetch` 路由和平台 SQLite Durable Objects，不引入路由框架或依赖容器。鉴权先于参数和目标校验；客户端提交字面 IP 的规范十六进制编码，端口固定 443；服务端独立验证公网属性和官方网段，不能提交域名、其他端口或 URL。查询只允许各一个 `v=1`、`target`，重复或未知参数被拒绝。公共模式验证服务端签名后才访问安装对象；额度预留在全部校验之后、TCP 连接之前。

## 接口与配置

| 接口                                                  | 行为                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                         | 返回服务状态、协议版本和 `capabilities.tunnel` 开关值；不代表上游连通                                                                                                      |
| `GET /v1/config`、`POST /v1/devices`                  | 公开配置及安装凭据签发；受启动接口速率限制，不设每日激活次数上限，不接收 Telegram 身份                                                                                     |
| `POST /v1/devices/refresh`、`POST /v1/devices/revoke` | 以刷新凭据换取短期访问凭据或撤销安装授权；请求体仅允许 `{}`                                                                                                                |
| `GET /v1/tunnel?v=1&target=<ID>`                      | 要求 Bearer、合法参数、官方网段内公网 IP:443 和 WebSocket Upgrade；关闭时返回 `501 / TUNNEL_NOT_IMPLEMENTED`，启用后连接上游成功才返回 `101`；连接失败或超时返回脱敏 `502` |

| 配置                                       | 来源与约束                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_TOKEN`                              | 独立开发凭据，本地 `.dev.vars` 与部署用凭据文件保持忽略；线上通过 Worker Secret 配置，不能与 Telegram 会话共用或打包进公开客户端 |
| 官方 CIDR                                  | 固定 HTTPS 官方源，按需获取并缓存 1 小时；不使用固定 IP 列表或过期回退，详见 [动态目标策略](telegram-network-policy.md)          |
| `RELAY_ENABLED`                            | 仅字符串 `"true"` 开启实验传输；`wrangler.jsonc` 默认 `"false"`                                                                  |
| `PUBLIC_SERVICE_ENABLED` / `PUBLIC_ORIGIN` | 公共开关默认关闭；公开地址固定为 HTTPS 项目域名，不接受调用方指定转发地址                                                        |
| `PUBLIC_SIGNING_KEY`                       | Worker Secret；只在服务端用于令牌签名与每日地址摘要，轮换使已有安装凭据失效                                                      |

鉴权与参数检查通过后，`false` 直接返回 `501`，不获取官方策略或预留预算。目标不允许返回 `403`，策略无法取得返回 `503`。不得把令牌写入 URL、源码、日志或提交的 Wrangler 配置。健康检查和错误不输出目标、凭据或上游异常内容。

## 实验传输契约

WebSocket 显式使用 `arraybuffer`：数据帧为非空二进制；文本只允许预期中的字面量 `ACK`。客户端将每帧交给本机 TCP 并 flush 后回复 ACK；Worker 下行允许窗口内多帧连续发送，按 FIFO 确认释放对应字节，窗口满时停止读取上游。协议仍为 v1，兼容现有逐帧确认客户端。上行仍由客户端每发送一片等待 Worker 写入上游后的 ACK。握手成功不代表媒体可播。

| 限制                      | 当前值                  |
| ------------------------- | ----------------------- |
| 单帧 / 上游待写队列       | 64 KiB / 256 KiB        |
| 下行未确认窗口            | 256 KiB，同时最多 64 帧 |
| 双向累计 / 单连接最长时间 | 64 MiB / 15 分钟        |
| 连接 / 空闲超时           | 5 秒 / 30 秒            |
| 最老下行帧确认超时        | 30 秒，不因其他活动延后 |

上游 EOF 后等待已发送帧全部确认再关闭；异常 ACK、帧或队列违规、流量/时间超限及上游失败会关闭双方、解除窗口等待、取消读写和清理计时器。传输限制之外，公共服务在连接前预留设备/全局额度，关闭时幂等结算；未结算预留保守保留满额。共享令牌仅用于私有开发模式。具体策略见 [默认服务](public-service.md)。

## 原生桥接与平台边界

`lib/data/services/relay/relay_bridge.dart` 只监听 IPv4 环回地址，提供实验 SOCKS5 CONNECT，最多 6 条本机连接。公共模式按有效官方 CIDR 匹配并编码请求 IP，范围外地址拒绝；私有工具可保留本机地址映射，但服务端仍独立检查官方范围；桥接通过 WSS Authorization 发送令牌，不设置系统代理。入口工具为 `tool/relay_bridge.dart`，凭据由本机令牌文件读取。

此桥接已接入原生 Flutter 登录；公共模式从默认服务读取配置，每次 WSS 连接前取得有效短期凭据，刷新凭据留在系统安全存储。Windows 公共凭据下五个 DC 握手及原会话/25 条片库恢复通过；Android 两 ABI 原生库已交付，真机已完成验证码和两步验证至 ready；iOS 原生仍待交付。Web 不能使用 `dart:io` 或环回 SOCKS5，浏览器 WebSocket 也不能自定义 Authorization，因此需要独立协议适配。详见 [原生中转 ADR](https://github.com/zhangheng2022/tg-cine/blob/master/docs/adr/0001-native-relay.md)。

## 开发与验证

在 `worker/` 使用 Node.js 24 执行 `npm ci`。本地 `.dev.vars` 可从 `.dev.vars.example` 复制；服务默认关闭；实验启用后仅允许官方动态范围内的公网 IP:443。`npm run dev` 强制本地运行。

```powershell
npm run format:check
npm run check
npm test
npm run build
npm run test:relay
```

`check` 生成已忽略的 Wrangler Env 类型并检查源码/测试；`test` 为 Vitest 非监听运行。`build` 仅 dry-run 打包到 `dist/`，不部署。

`test:relay` 另需先在 `` 执行 `flutter pub get`；它创建临时令牌、本地 TCP echo 和本地 workerd，运行 Dart SOCKS5 桥接，检查 1 MiB 字节顺序与内容及正常退出，并清理自己的临时配置。仅测试夹具将随机令牌写入已忽略的临时配置，不修改项目默认开关。联调使用临时独立入口，仅连接其自建 echo；生产 `targets.ts` 仍拒绝环回/私网，不部署测试入口。

CI 包含独立 Worker 检查和 Flutter 作业中的组合联调，没有部署步骤或 Cloudflare 凭据。`.wrangler/`、`.dev.vars`、生成类型和构建产物保持忽略。本地运行、原型握手和 dry-run 均不证明边缘 TCP、Telegram 登录、长时间播放、费用或远程 CI 通过。
