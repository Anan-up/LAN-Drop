# 局域网 P2P 文件传输

纯白极简的网页文件传输工具。文件在浏览器之间通过 **WebRTC 点对点直连**传输，**完全不经过服务器中转**——服务器只负责托管页面和撮合连接（WebSocket 信令）。适合在同一局域网内把文件从一台设备直接发到另一台，不经过任何第三方服务器。

## 特性

- **真正点对点**：文件数据走 WebRTC DataChannel，服务端只转发建立连接所需的握手信息（SDP / ICE），不碰任何文件字节
- **纯白极简 UI**：无多余装饰，单色强调，移动端自适应
- **多文件 / 双向互传**：支持拖拽、多选，发送端与接收端可同时工作
- **可靠传输**：64KB 分片 + 背压控制（`bufferedAmount`），按序重组，带实时进度
- **稳定协商**：采用 WebRTC「完美协商（perfect negotiation）」模式，`polite` 角色由服务端分配，杜绝双方僵死
- **自动重连**：WebSocket 断线后指数退避自动重连并回到原房间；对方离开后可等待其重连，也可随时主动离开
- **流式落盘**：支持 File System Access API 的浏览器（HTTPS / localhost）中，接收端分片直接写入磁盘，**不在内存中缓存整文件**，GB 级文件也不爆内存；不支持时自动回退到 Blob 下载
- **断点续传**：传输中途连接断开并恢复后，接收端从已写入的字节数继续收发，无需从头重传（同一页面会话内有效）
- **二维码配对**：一键生成房间二维码（含可分享的加入链接），对方扫码即自动填入房间码并加入，免去手动输码
- **接收端可拒绝 / 发送端可重试**：接收端收到文件可点「拒绝」（发送端立即得知、不再空等 5 分钟）；发送端一旦失败（对方拒绝 / 未就绪 / 连接中断）显示「重试」按钮，一键重新发送，免得重新拖文件
- **更强的安全性**：服务端下发 CSP 响应头（仅同源，WebSocket 为同源连接故 `connect-src 'self'` 已覆盖），并对房间码长度、WebSocket 消息体大小（`maxPayload`）与单连接消息频率做限制，抵御局域网内的恶意 / 误发请求
- **零配置部署**：一个 `Express` + `ws` 进程即可，HTTP / HTTPS 自动适配

## 工作原理

```
┌──────────────┐         WebSocket 信令（仅握手）        ┌──────────────┐
│  浏览器 A     │  ───────────────────────────────────▶  │  信令服务器    │
│  (发送端)     │  ◀───────────────────────────────────  │  (本进程)     │
└──────┬───────┘                                         └──────┬───────┘
       │                                                          │
       │            WebRTC DataChannel（文件字节，直连）            │
       └──────────────────────────────────────────────────────────┘
                                                                            │
┌──────────────┐                                                            ▼
│  浏览器 B     │  ◀──────── WebRTC DataChannel（文件字节，直连） ────────┘
│  (接收端)     │
└──────────────┘
```

1. 两个浏览器都打开服务端地址，输入**相同房间码**加入同一房间
2. 服务端通知双方可以开始协商（`peer-ready`，并分配一正一反的 `polite` 角色）
3. 两端通过 WebSocket 交换 SDP / ICE 候选，建立 P2P 连接
4. 连接建立后，文件通过 DataChannel 在两端直传；服务器此后不再参与

> 局域网内会优先走本地候选地址直连，延迟最低、不占公网带宽。已包含一个公共 STUN 仅用于候选发现，不中转任何文件数据。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

默认监听 `3000` 端口。可用环境变量改端口：

```bash
PORT=8080 npm start
```

### 3. 浏览器打开

- 本机：`http://localhost:3000`
- 局域网其他设备：把 `localhost` 换成**服务器的内网 IP**，例如 `http://192.168.1.50:3000`

### 4. 开始传输

1. 两端浏览器都打开上面的局域网地址
2. 一端点「随机」生成房间码（或手动输入），点「加入」；另一端可输入**相同房间码**加入，或点「生成二维码邀请」让对方扫码加入
3. 状态点变绿「已连接 · 可传输文件」后，把文件拖进框（支持多选、双向互传）
4. **接收端**：支持 File System Access 的浏览器（HTTPS / localhost）会先显示「保存为…」按钮，点一下选好保存位置后即开始接收并流式落盘；其他环境直接接收，完成后点「下载」存到本机
5. **断点续传**：传输中若连接中断，恢复后双方会自动从断点继续，进度条接着走，无需重传

## 部署说明

- **防火墙**：确保服务器端口（默认 3000）在局域网内可访问
- **HTTPS**：用 HTTPS 部署时，WebSocket 自动升级为 `wss://`，无需改代码。建议生产环境配合反向代理（Nginx 等）启用 HTTPS
- **跨网段 / 公网（TURN）**：当前为纯局域网直连设计。跨网段或跨公网场景需要 TURN 中继（会经过中转）。部署时**无需改前端代码**，设置环境变量 `ICE_SERVERS` 即可，例如：
  ```bash
  ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]' npm start
  ```
  前端启动时会从 `/config.json` 读取该配置用于 `RTCPeerConnection`。

## 项目结构

```
.
├── server.js            # Express 托管静态页 + WebSocket 信令中转（仅握手，不碰文件）
├── public/
│   ├── index.html       # 纯白极简界面
│   ├── style.css        # 极简样式（白底、黑灰字、细线、单色进度条）
│   ├── app.js           # WebRTC 连接、分片传输、背压、流式落盘、断点续传、二维码
│   └── vendor/
│       └── qrcode.js    # 本地内置的二维码生成库（零依赖，纯局域网无外网也可生成）
├── package.json
└── package-lock.json
```

## 已处理的关键问题（实现要点）

- **`polite` 服务端分配**：完美协商要求双方角色确定，服务端按加入顺序分配一正一反，排除「双方都 impolite 互相等 answer」的死锁
- **发送端串行化**：`sendQueue` + `pump()` 保证多文件传输时 `meta → 分片 → done` 严格不交错，接收端用单一 `recvCtx` 正确重组
- **`pump` 死锁防护**：`pump` 用 `try/finally` 保证 `sending` 必定复位；`sendFile` 在 `arrayBuffer()` 异步读取后重新检查通道状态，断线窗口内不会抛穿透异常
- **背压挂起防护**：等待 `bufferedamountlow` 时同时监听 channel `close`，对端掉线不会永久挂起
- **`connect()` 幂等**：自动重连定时器与手动连接不会创建多条 WebSocket
- **`pc.close()` 空引用防护**：关闭前解绑所有事件 handler，避免异步状态变更读到已置空的 `pc`
- **重连回归修复**：`doJoin` 优先使用 `joinedRoom`，断线重连后能自动回到原房间
- **资源清理**：`resetConnection` 清空待发队列、释放接收端 Blob URL、按上限回收过期下载链接，避免内存累积与泄漏
- **连接状态细分**：`disconnected`（可能自恢复的临时态）与 `failed`/`closed` 分别提示
- **流式落盘**：接收端在 `file-meta` 后由用户手势触发 `showSaveFilePicker`，拿到可写流后通知发送端（`recv-ready`）才开始发分片；分片直接 `writer.write` 落盘，内存恒定。不支持时回退 Blob + 下载链接
- **断点续传（会话内）**：发送端用 `sendCtxById` 保留 `{file, item}` 以便续传，`resetConnection` 不清空；接收端 `recvCtx`（含可写流 / 已收偏移）在传输中默认保留；重连后接收通道 `onopen` 触发 `maybeResume`，向发送端发 `resume-request {id, offset}`，发送端从断点续发
- **二维码配对**：`?room=` 房间码由 `app.js` 初始化时解析并自动加入；「生成二维码邀请」按钮用本地内置的 `qrcode-generator` 生成加入链接二维码（QR 内容含 `location.origin`，扫码设备需能访问该服务器地址）。该按钮独立于加入行，连接前后均可点击
- **拒绝 / 重试协议**：接收端「拒绝」会发 `recv-reject`，发送端立即以 `false` 解除 `waitRecvReady`（不再卡 5 分钟），并据 `ctx.rejected` 显示「对方拒绝接收」+「重试」；发送端各失败分支统一经 `fail()` 补「重试」入口，`retryFile(id)` 复用 `sendCtxById` 中保留的 `file` 重新入队
- **`waitRecvReady` 断线解除**：`resetConnection` 不再只清空 `pendingRecvReady`，而是逐个 `clearTimeout` 并以 `false` `resolve`，对端掉线后发送端不会卡在等待接收端就绪最长 5 分钟
- **竞态防护（通道 await 后状态）**：`file-done` 的 `writer.close()` 异步期间、以及 `addSaveButton` 的 `showSaveFilePicker` 弹窗期间，均先捕获局部 `ctx`/`recvCtx` 引用，await 后复查引用仍是当前上下文，避免对端掉线触发 `resetConnection` 置空后读到 `null` 抛 `TypeError`
- **拒绝后状态一致（P0-A）**：接收端「拒绝」时会同步禁用并改写「保存为…」与「拒绝」按钮，且 `addSaveButton` 回调在保存框返回后复查 `ctx.done`——杜绝「先拒绝再点保存」造成 writer 泄漏、误发 `recv-ready`、接收端进入「等数据永远等不到」死状态
- **重试不误报拒绝（P0-B）**：`retryFile` 重试前 `delete ctx.rejected`，因此二次超时（接收端既不保存也不拒绝）会准确显示「对方未保存」，而非把上次拒绝标记误带上显示「对方拒绝接收」
- **失败分支统一收口（P0-C / P1）**：`sendFile` 内 `arrayBuffer()` 异步读取后断线、以及 `pump` 的 catch，统一走 `fail()` 添加重试按钮，杜绝个别分支漏重试入口、两处逻辑漂移
- **随机串改用 `crypto`**：房间码（`randRoom`）与文件 id（`fileId`，UUIDv4）改用 `crypto.getRandomValues` 生成，替代 `Math.random`，避免文件 id（兼作续传 key）碰撞
- **`resetConnection` 语义清晰化**：入参改为 `{ keepJoinUI, full }` 选项对象，是否保留在传文件由「是否有未完成的 `recvCtx`」推导，消除原先 `keepTransfer` 被强行覆盖的歧义
- **服务端健壮性**：房间码长度校验（1–64，超长回 `bad-room`）、`WebSocketServer` 设 `maxPayload: 8KB`、单连接每 1s 窗口 100 条消息的滑动窗口限流（`JSON.parse` **之前**计数，非法 JSON 也计入限流、无法空转绕过）、`send` 包 `try/catch`、客户端 `ws.onmessage` 对非法 JSON 直接忽略，均避免局域网内的无效 / 恶意请求导致白屏或资源耗尽
- **CSP 与 ICE 配置下发**：服务端统一设置 `Content-Security-Policy`（`default-src 'self'`；`img-src` 白名单含 `data:` 以允许 `qrcode.js` 的 `data:image/gif`；`connect-src 'self'` 已覆盖同源 WebSocket，不再放行任意 `ws:`/`wss:` 地址，收紧注入外连面）；新增 `GET /config.json` 透出 `ICE_SERVERS` 环境变量，前端用 `iceConfigReady` promise 在 `createConnection` 中 `await` 后再建 `RTCPeerConnection`，跨公网加 TURN 无需改前端，且 `?room=` 自动加入时 TURN 配置也已就绪
- **`file-done` 丢失修复（边界 P1）**：发送端发完分片后 `sendChannel.send({type:'file-done'})` 恰在断线窗口抛错会走 `fail()` 且 `sendCtxById` 不清，重连后接收端 `resume-request` 因 `offset >= size` 被直接忽略、永远等不到 `file-done` 而卡 100%。已在 `resume-request` 分支特殊处理：接收端已收全字节（`offset >= size`）时，若通道仍开就**重发一次 `file-done`** 收尾并删除 `sendCtxById`，接收端正常完成
- **P3 时序收尾（长尾时序，零风险清理，均按审查 diff 落地）**：
  - **`file-done` 的 `await writer.close()` 窗口**：该分支改为**先 `recvCtx = null` 再 await**，避免 await 期间同 id 新 `file-meta`（发送端恰在此时重试）复用 DOM 把新节点误标「已完成」、进度错位；`resetConnection` 的 `recvCtx && !recvCtx.done` 判定因 null 直接短路，不受影响
  - **`maybeResume` 在 `received === 0` 路径**：已有可写流但 `received === 0` 时改走 `reAddSaveButton`（让用户重选保存位置），语义比重发空 `file-meta` 再被 `writer.abort()` 掉更直接、避免按钮「已就绪→保存为…」来回跳；Blob 兜底分支保持直接 resume（空传输无害）
  - **断线清空 `roomInput` 视觉抖动**：`resetConnection` 仅在用户主动离开（`full:true`）时清空输入框，断线重连不再清空（`joinedRoom` 仍在，重连后自动 `doJoin`）
- **房间生命周期补全（本轮审查）**：
  - **`full` 不再留孤儿连接**：收到 `full`（房间满）分支原先只清空 `joinedRoom` 与加入行，若用户正连在旧房间再换到满员房间，旧 `pc` 会残留成孤儿连接、且此后 WS 抖动无法重连回原房间。已补 `resetConnection({ full: true })`，先把旧 P2P 断开再回加入界面
  - **`joined` 即显示离开按钮**：进入房间（单人等待或已连接）后立刻 `leaveBtn.hidden = false`，中途想换房直接点「离开」，不必刷新页面
  - **`onFileMeta` 选择器用 `CSS.escape`**：`lists.querySelector('.item[data-id="..."]')` 的 id 经 `CSS.escape` 处理，防御任意文件 id 破坏选择器（当前 id 为 UUIDv4 十六进制，实际无影响，属防御性加固）
  - **`createConnection` 防并发泄漏 + 防孤儿 pc（P2）**：`await iceConfigReady` 之后先补 `if (!ws || ws.readyState !== WebSocket.OPEN) return;`（用静态常量 `WebSocket.OPEN`），再 `if (pc) return;`。前者堵住「`iceConfigReady` 挂起期间 WS 断开重连」场景——单靠 `if (pc) return` 仍会在此窗口创建孤儿 `pc` 并因 `pc` 非空让重连后的 `peer-ready` 被跳过、永远协商不上；新增的 ws 存活检查使挂起恢复时已断开的调用直接返回，待重连 OPEN 后再正常建 `pc`。二者协作逻辑不变，正常路径零影响
- **断线抖动保留已完成列表（边界 P1）**：`resetConnection` 的 `keepTransfer` 原先只要 `recvCtx` 已 `done`/为空就清空整个列表，导致一次短暂 WS 抖动就丢失所有已完成文件的 UI 与下载链接。已改为「有未完成的接收 **或** 列表里存在 `.item.done` 条目」即保留，仅在用户主动离开（`full:true`）时彻底清空；既不会清掉已完成历史，也不会在没有传输时残留空列表
- **`recvUrls` revoke 跟随 `keepTransfer`（边界 P2，上轮补丁的对称修复）**：上一轮把"保留已完成历史"加进 `keepTransfer` 后，无条件 `revokeObjectURL` 仍会在断线重连时把保留下来的"下载"链接全部作废、点开变死链。已把 revoke 整段包进 `if (!keepTransfer)`，使断线重连保下来的链接真可用，仅主动离开（`full:true`）才一次性清空；`MAX_RECV_URLS = 8` 保证不 revoke 也不会无界增长
- **`'bad-room'` 孤儿连接（边界 P2，与 `'full'` 对称）**：`handleWs` 的 `bad-room` 分支原只 `resetJoinUI()`，当用户正连在旧房间 P2P 上时输入超长/非法房间码换房失败，会留下"WS 不在任何房间但 `pc` 仍连着"的孤儿连接。已与 `full` 分支一致改用 `resetConnection({ full: true })`（内部会调 `resetJoinUI`），先断开旧 P2P 再提示，避免掉线后无法自动重连
- **重试复用 DOM 条目（边界 P2）**：接收端 `onFileMeta` 收到**同 id** 的 `file-meta`（发送端点「重试」重发、id 不变）时，原本会新建第二个 DOM 节点，列表出现两条同名同大小项。已改为先查 `lists.querySelector('.item[data-id="<id>"]')`，命中则**复用**原条目（清 `done`、进度归零、移除旧操作区）后再接收；并顺手在 `addItem` 补 `item.dataset.id = id`（此前 `id` 参数未被使用，既是修复所需也消除该代码异味）

## 已知限制 / 后续方向

- **大文件内存**：在安全上下文（HTTPS / localhost）下已通过流式落盘解决；但经 HTTP 局域网 IP 访问（非 localhost）时浏览器不提供 File System Access API，会自动回退为 Blob 全量缓存，GB 级文件仍占内存。需要 HTTPS 才能享流式落盘
- **断点续传范围**：仅限「同一页面会话内」连接断开又恢复。页面刷新后文件句柄 / 可写流丢失，会从头重传（File System Access 权限不可跨刷新恢复，且未引入 IndexedDB 持久化）
- **跨公网**：需补充 TURN 配置
- **可迭代功能**：刷新后持久化续传（IndexedDB）、文件夹整体传输

## 自动化验证

项目附带真实浏览器端到端测试（Playwright + 无头 Chromium），覆盖静态审查无法发现的运行时问题：

- **基础链路**：两端经本机信令服务器建立 WebRTC P2P 连接、二维码生成、1MB 文件传输且接收内容与原文件逐字节一致、发送端进度条到达 100%、两端无任何控制台错误
- **断点续传（真实场景）**：10MB 文件传输中途以 `setOffline` 模拟网络分区，两端自动重连后从断点续传，文件仍逐字节一致、状态恢复为已连接
- **拒绝 / 重试 / CSP**：接收端「拒绝」后发送端立即显示「对方拒绝接收」并出现「重试」按钮，点击重试可重新提议（接收端再次出现保存按钮）；经 File System Access 路径（注入伪 `showSaveFilePicker`）验证流式落盘「已保存到本地」；二维码在 CSP 下用 `data:image/gif` 正常生成，全程零控制台错误
- **竞态专项（P0-A）**：注入可控 `showSaveFilePicker`，模拟「先点保存（弹窗挂起）→ 保存框等待期间点拒绝 → 弹窗才返回」的竞态，验证修复后不创建 writer、不向发送端发 `recv-ready`，接收端停留在「已拒绝」
- **重试误报专项（P0-B）**：把 `RECV_READY_TIMEOUT` 临时缩短到 2s，验证「拒绝 → 重试 → 接收端不操作直到超时」最终显示「对方未保存」而非误报「对方拒绝接收」
- **失败收口专项（P0-C / P1）**：仅发送端加入房间时即队列文件，验证 `sendFile` 立即走 `fail()` 显示「连接已断开」并给出「重试」按钮；待第二端加入后点重试，重新建连并成功传输（流式落盘「已保存到本地」）

测试中发现并修复的问题：连接后「二维码」按钮因位于被禁用的加入行内而「看得见点不动」，已将其移出加入行、改为随时可点的「生成二维码邀请」。

> 说明：测试为排除「手势保存框」对自动化的干扰，强制走 Blob 兜底路径验证**数据面**正确性；流式落盘（File System Access）与「手势保存框」交互仍需在支持该 API 的真实浏览器中手动验证。

本轮新增的 3 条边界修复（① `file-done` 在断线窗口丢失、② 断线抖动清空已完成列表、③ 同 id 重试重复条目）均属「断开连接那一瞬间恰好走到某个 await / 恰好用户点了重试」级别的长尾场景，难以用稳定 E2E 复现（自动化触发「`file-done` 恰好在 DataChannel 关闭那一刻 `send` 抛错」会非常 flaky）。因此本轮以**精确逻辑复核 + `node --check` 语法校验 + 全量回归既有 E2E 仍零控制台错误**为准：改动均为局部分支调整，未触碰已验证的主干链路（完美协商、背压、流式落盘、断点续传、拒收、重试、CSP、限流），故既有 P0/A/B/C 与 P1 行为不受影响。

## 许可证

[MIT](LICENSE)
