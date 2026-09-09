# TypeScript 版本

本目录基于实际 Python 源码迁移。TypeScript 版本现位于默认主分支 `main`（原 `typescript-rewrite`）；完整原 Python 版本保存在 [`legacy` 分支](https://github.com/LogRassWku/Agent-IP-KVM/tree/legacy)。原 `src/agent_ip_kvm/`、`tests/`、`scripts/` 和 Python 启动方式保留。

## Windows 模拟运行

需要 Node.js 22.12+，本次在 Windows / Node.js 24.17.0 上验证。

在仓库根目录运行：

```powershell
npm ci
npm run build
npm start -- --source synthetic --enable-hid --hid-backend simulated
```

打开 <http://127.0.0.1:8080>。模拟版本生成与 Python 相同的 1280×720、30 fps 彩条，提供可解码 JPEG 和 MJPEG 流。HID 只在内存记录事件，不向本机或其他电脑发送输入。模拟运行不需要 Python、开发板或外部 FFmpeg。

模拟源的屏幕分辨率菜单和原版一样不可调整。模拟图用于验证链路与交互，不是模拟 Windows 桌面；键盘输入不会改变彩条。

默认启动不启用 Windows HID。需要测试键鼠交互时使用上面的显式模拟参数。运行数据默认在 `data/typescript/`，与 Python 默认 `data/` 分开。

## 验证

```powershell
npx playwright install chromium
npm run check
```

`check` 包含后端和前端类型检查、构建、单元／HTTP／真实文件视频测试、Chromium 浏览器交互测试。开发依赖中的 FFmpeg 和 ffprobe 只用于生成及读取测试文件，安装时会下载对应平台二进制。模拟服务运行时不调用它们。

```powershell
npm test
npm run test:e2e
npm start -- --frames 30
npm start -- --probe-hid
npm start -- --discover-v4l2
```

Windows 上后两条只读命令返回 `unsupported_platform`。测试报告在 `work/playwright-report/`，失败轨迹在 `work/playwright-results/`。GitHub Actions 定义了 Windows/Linux x64、Node 22/24 矩阵；本地通过不代表远程 CI 已运行。

## 本地视频文件

需要 `ffmpeg`、`ffprobe` 位于 PATH，或显式传入路径：

```powershell
npm start -- --source file --file "C:\Videos\test.mp4" --ffmpeg "C:\Tools\ffmpeg.exe" --ffprobe "C:\Tools\ffprobe.exe"
```

只接受实际存在的本地文件。保留自动探测尺寸／帧率、自然结束、No Signal、刷新重播和按需截图。TypeScript 文件适配器直接让 FFmpeg 输出 JPEG，替代 Python 版 RGB24 再编码；内部文件源格式因此为 `MJPEG`，浏览器接口不变。

## 功能和代码对应

| 原 Python 模块 | TypeScript 实现 | 验证范围 |
|---|---|---|
| `web.py` HTTP、MJPEG、截图、UI | `src/server.ts`、`src/video.ts`、`ui/` | Windows HTTP + Chromium |
| `video/synthetic.py` | `SyntheticSource` | 原彩条像素、连续帧、生命周期 |
| `video/file.py` | `FFmpegSource` | Windows 真实 FFmpeg 文件解码、结束、重启 |
| `video/v4l2*.py` | `src/linux.ts`、`FFmpegSource` | 解析器、平台保护；设备采集未实测 |
| `hid/base.py`、`simulated.py`、`linux_gadget.py` | `src/hid.ts` | 模拟事件、报告字节、释放与故障；USB 未实测 |
| `hid/probe.py`、`config_plan.py`、`recovery.py` | `src/linux.ts`、`templates/` | 只读探测、离线清单和恢复包生成；重绑未实测 |
| `agent_control.py` | `src/agent.ts`、`src/stores.ts` | 白名单、风险、摘要、过期、拒绝、重复执行、审计 |
| `host_info.py`、PC 建议和配对 | `src/stores.ts` | 嵌套数据校验、令牌认证、缓存 |
| `agent_sessions.py`、`agent_chat_jobs.py` | `src/stores.ts` | 持久化、删除墓碑、作业去重和恢复 |
| `model_setup.py` | `src/model-setup.ts` | 路径、模型目录、私密启动地址、进度；安装未执行 |
| `remote_model.py`、远程工具循环 | `src/remote-model.ts` | 模拟 API、文本／视觉请求、审批边界；真实提供商未调用 |

HTML、CSS、SVG 保持原内容；`app.js` 迁入 `ui/app.ts`，增加 DOM 与请求参数类型，通过构建输出 `/app.js`，原页面 URL 和交互继续可用。后端开启 TypeScript strict。为控制 UI 行为迁移风险，前端目前保留 `noImplicitAny: false`、`strictNullChecks: false`，没有 `@ts-nocheck`；进一步细化前端领域类型可独立推进。

原 POST 接口全部保留；另外提供 `POST /api/hid/emergency-stop` 和 `/api/hid/arm`，请求体 `{}`。紧急停止使待执行计划失效并释放输入，重新启用需要显式调用 arm。原页面布局没有新增按钮。

按需截图不落盘。用户进入 Agent 模式时停止共享视频流；实时客户端共享一次采集，慢客户端跳过旧帧而不无限积压。没有客户端时释放视频源。运行状态额外包含 `hardware_validation.typescript_rdk_x5: "unverified"`。

## PC Agent 与远程模型

原 Windows 探针 `scripts/report-windows-host-info.ps1` 继续可用，指向 TypeScript 服务地址即可。PC Agent 的配对令牌必须保存在 `data/typescript/pc-agent-token`（24–256 字符）；有令牌时主机清单上报也需要 Bearer 认证。普通模拟演示不需要令牌。

PC Agent 配置界面的“安装”保留原 HID 启动流程。模拟后端仅记录按键，任务会停在 `starting`，除非测试用认证进度接口上报；不会虚构安装成功。真实安装需要用户点击原配置卡、已配对 PC Agent、目标可达的 `--pc-agent-callback-url`、美式键盘布局和实际硬件验证。

远程模型配置只在本地私密 JSON 保存密钥，GET 状态／配置与审计不返回密钥。模型目录沿用 Python 基线，不将本次迁移视作对提供商模型可用性的确认。测试使用模拟响应，没有调用付费模型。调用 `capture_screen` 才上传一张截图。所有输入建议继续经过计划审批。

## Linux / RDK X5（未经过实机验证）

TypeScript 的全部硬件路径都尚未实机验证；仓库原 README 中的 X5 实测记录属于 Python 版本，不能沿用到本次重构。

在独立检出目录构建，安装系统 FFmpeg 和 `v4l2-ctl` 后，可手动启动：

```sh
npm ci
npm run build
node dist/cli.js --host 127.0.0.1 --port 8766 --source v4l2 \
  --device /dev/video0 --width 1920 --height 1080 --fps 30 --hid-backend auto
```

V4L2 使用 `-c:v copy` 转发采集卡 MJPEG，不重新编码。HID 通过 ConfigFS `dev` 的主／次设备号匹配字符设备，要求 UDC 为 `configured`，允许缺少相对鼠标端点，支持绝对指针及独立 USB 唤醒报告。软件不会自动创建或重绑 Gadget。

将系统服务安装脚本分开放在 `typescript/linux/`：

- `install-web-service.sh USER PROJECT_DIR`：新建 `agent-ip-kvm-web-ts.service`，端口 8766、独立数据目录，不停止／改写 Python Web 服务。
- `install-hid-gadget-service.sh`：Node 生成描述符，创建独立 TS 服务和安装目录。已有旧 HID 服务运行时拒绝安装，可直接复用其已配置端点。
- `apply-hid-gadget.sh`：保留原 ConfigFS 操作脚本和管理网络保留逻辑。

这些脚本只写入仓库，**本次没有运行系统安装、USB 重绑或真实输入**。同一采集卡和 HID 控制权应分时测试，避免两个版本同时争用硬件。

原 UVC 电源、HID 访问权限和 USB 网络脚本本身是 Shell，无需改写；保留在 `scripts/`。离线恢复包可通过 `--plan-composite --write-recovery-bundle DIR` 生成，默认 dry-run，临时应用会先启动回滚看门狗。

## 已知基线边界

- 原版完整的 Web 用户认证与单控制者租约尚未实现，本次未把它们标成完成；默认只监听回环地址。Linux 服务示例与原服务相同，属于受信管理网络开发部署。
- 板端 Qwen 本地推理尚未接入，页面原本标为 Qwen 的默认路径继续使用规则规划器。真实 HDMI 语义识别默认返回 `unknown`。
- 每次输入后的校验保留截图与识别证据，但没有新增通用的“预期画面匹配”判断器；这部分属于原需求待实现能力。
- 会话和安装任务持久化，聊天作业和审批计划只在当前服务进程内保存；服务重启后需要重新规划审批。
- Linux 字符设备写入、UVC 热插拔、1080p30 性能、USB 唤醒、UEFI 兼容、开机服务与回滚，都必须在有板后独立验收。

## 原版保留与回退

原 Python 版本可继续按根 README 的命令启动；当前修改不替换其源码或安装脚本。TypeScript 默认数据目录隔离。需要导入旧会话时先停止对应服务，复制所需 JSON 到新数据目录，保留备份后再启动。不要让两个进程同时写同一个数据文件。

## 2026-09-09 逻辑修复与模块边界

- Agent、手动键鼠和安装启动共享操作占用权；另一个操作正在执行时返回 409。紧急停止独立生效，验证期间停止的计划不会被标为完成。
- 更换远程 API origin 必须填写新地址对应的密钥；同一 origin 下编辑其他设置可以继续保留旧密钥。
- 会话使用服务端 `revision` 条件更新：新会话省略或传 0，更新必须携带上次返回的 revision。重复的相同写入可安全重试；冲突返回 409。UI 会保留远端版本，并将本地编辑保存在独立的冲突副本中。
- 单会话 JSON 上限统一为 1 MB（UTF-8，仍限制 300 条消息、每条 20000 字符），HTTP 外层另有少量封装余量。同步失败会显示“未同步”，连接恢复后重试；超过上限时保留本地内容并提示新建会话。
- 安装任务在发出输入前领取，只能按允许的方向推进。失败后可检查目标状态再重试，重试使用全新 task_id；旧尝试的进度不会覆盖新任务。新增 `POST /api/model-setup/cancel`，只允许取消未启动或失败的任务，不会声称能停止已在电脑上运行的安装器。
- 审计日志约 4 MB 轮转一次，保留当前文件和 `.1` 上一份；读取最近事件仅扫描有界尾部。若需要完整长期历史，应定期归档这两份文件。

服务端：`server.ts` 负责依赖装配与生命周期，`routes.ts` 负责 HTTP 路由，`http.ts` 负责请求/响应边界，`setup-service.ts` 负责安装执行流程。共享的会话预算/版本契约和主机 schema 分别位于 `contracts.ts` 与 `host-schema.ts`。

前端：`api.ts`、`session-sync.ts`、`cards.ts`、`host-info.ts`、`agent-jobs.ts`、`formatting.ts` 和 `view-types.ts` 已分离，并通过 `tsconfig.features.json` 的完整 strict 检查；`app.ts` 保留页面装配及原视频、键鼠交互，继续渐进式类型检查。构建会将模块打包为原 `/app.js`，HTML、CSS、SVG 保持不变。

会话存储仍使用有界 JSON，未引入数据库。多进程共用数据目录和全站用户登录鉴权仍不属于已实现能力；操作占用权解决的是同一服务进程内的输入序列互相干扰。
