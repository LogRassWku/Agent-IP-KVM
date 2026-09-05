# Agent IP KVM

Agent IP KVM 是一个面向多种 Linux 开发板的开源智能 IP KVM 项目。项目计划通过视频采集、USB HID、权限控制和 Agent 协作，让用户远程观察并受控操作电脑的操作系统、安装环境和 BIOS／UEFI。

RDK X5 是第一个开发与验证平台，但核心软件不绑定单一型号。不同开发板通过适配层接入各自的视频采集、USB Gadget、硬件加速和系统管理能力。

## 当前状态

项目已完成真实 HDMI 采集到浏览器的连续画面闭环和 Web 键盘最小输入链路，并已实现网页坐标到 USB 绝对指针的映射：

- RDK X5 基础系统和远程管理链路已验证。
- 首款 USB UVC 采集卡已确认故障；替换为 UGREEN 25854 后，RDK X5 已取得真实 HDMI 画面。
- 已建立平台无关的视频源接口，并以 1280×720、30 fps 的模拟视频源跑通取帧、状态和错误处理。
- 最小浏览器界面已经能持续显示 UGREEN 25854 的 1920×1080、30 fps MJPEG 画面，并直接转发 JPEG 帧以避免二次编码。
- 已加入只读 USB Gadget HID 探测工具，并在保留管理网络的情况下完成 Windows 键盘／鼠标枚举和自动回滚。
- 已建立平台无关的 HID 接口、内存模拟后端和 Linux USB Gadget 后端；RDK X5 已通过 Web 接口向测试电脑发送并释放一个小写 `a`，由 HDMI 回传画面确认字符进入记事本。
- Web 服务会自动发现已配置并可写的 Linux Gadget 键盘和绝对指针端点；相对鼠标按平台端点能力选配。鼠标进入视频画面后会直接同步绝对位置，并支持左／中／右键点击和滚轮。
- RDK X5 已安装并实测 `Qwen2.5-1.5B-Instruct Q4_K_M` 板端模型；首轮只读结构化输出可用，常驻模型 API 尚未接入项目。

UGREEN 25854 在 RDK X5 上需要保持 USB 设备唤醒；实测自动休眠会造成 HDMI 热插拔状态反复变化。仓库已提供可安装、可移除的 udev 电源规则。

## 验证模拟视频源

项目当前只需要 Python 3.10 或更高版本，不依赖第三方软件包。在仓库根目录运行：

```bash
PYTHONPATH=src python -m agent_ip_kvm.cli --frames 30
```

Windows PowerShell 使用：

```powershell
$env:PYTHONPATH='src'
python -m agent_ip_kvm.cli --frames 30
```

命令会读取 30 帧模拟画面，并以 JSON 输出分辨率、格式、帧序号、字节数、实测帧率和最终状态。它不会保存截图。

也可以通过 FFmpeg 读取本地视频文件：

```bash
PYTHONPATH=src python -m agent_ip_kvm.cli \
  --source file \
  --file /path/to/test-video.mp4 \
  --frames 30
```

文件源只接受本地存在的文件。它通过 `ffprobe` 读取第一条视频轨的分辨率和帧率，再通过 `ffmpeg` 输出统一的 RGB24 帧；文件自然结束时返回明确的 `end of stream` 状态。

## 探测 Linux 视频设备

RDK X5 和其他 Linux 开发板需要安装 `v4l2-ctl`。只查询设备和格式，不读取或保存画面：

```bash
PYTHONPATH=src python -m agent_ip_kvm.cli --discover-v4l2
```

输出包含每个 `/dev/video*` 节点的设备名称、驱动、总线、是否支持视频采集，以及离散的像素格式、分辨率和帧率。未安装工具、没有视频设备、单个节点探测失败和在非 Linux 系统运行时，命令会返回对应状态和说明。

当前 RDK X5 实测能够把 UGREEN 25854 的 `/dev/video0` 识别为视频采集节点，并把 `/dev/video1` 识别为元数据节点。设备支持 MJPEG 与 YUYV；项目使用 MJPEG 直通减少板端负载。

## 探测 USB HID 基础能力

在 Linux 开发板上运行以下只读命令：

```bash
PYTHONPATH=src python -m agent_ip_kvm.hid_cli
```

它会报告 USB Device Controller、ConfigFS、内核 HID 支持、当前 Gadget 功能，以及修改 Gadget 是否可能切断管理网络。该命令不会创建 HID 设备、重新绑定 USB 控制器或发送键鼠输入。

RDK X5 实测状态为 `in_use`：控制器 `35300000.usb` 已绑定 `RNDIS`、`ECM` 和只读存储功能，当前 USB QuickLink 管理连接依赖其中的网络功能。因此实际接入键鼠前，需要先设计保留管理网络的复合 Gadget 配置和断线恢复方法。

生成标准键盘、相对鼠标和绝对指针的离线复合配置清单：

```bash
PYTHONPATH=src python -m agent_ip_kvm.hid_cli --plan-composite
```

输出中的 `generated_only` 始终为 `true`。清单包含标准描述符、报告长度、校验值、需要保留的现有功能和重绑风险，但不会写入 ConfigFS。RDK X5 计划保留 `ECM`、只读存储和 `RNDIS`，再增加独立的 Boot Keyboard、相对鼠标与绝对指针功能。

为未来的实机重绑生成恢复文件包：

```bash
PYTHONPATH=src python -m agent_ip_kvm.hid_cli \
  --plan-composite \
  --write-recovery-bundle ./hid-recovery
```

文件包包含状态清单、只读预检查、回滚脚本、临时枚举脚本和本地恢复说明。回滚与临时枚举脚本默认都只显示计划；临时枚举只有显式运行 `sudo ./temporary-apply.sh --apply 45` 才会重绑 USB，并会在 45 秒后自动恢复。该脚本只建立键盘、相对鼠标和绝对指针接口，不打开 `/dev/hidg*`，因此不会发送输入。

临时枚举验证通过后，可以安装开机自动配置服务：

```bash
sudo sh scripts/install-hid-gadget-service.sh
```

服务会等待厂商 USB Gadget 配置完成，在保留现有功能的基础上加入项目自己的标准键盘和绝对指针。RDK X5 默认不挂载相对鼠标端点，以避开复合 Gadget 的端点资源限制；软件适配层仍支持其他开发板启用相对鼠标。撤销时运行 `sudo sh scripts/install-hid-gadget-service.sh --remove`。

RDK X5 已在 Windows 电脑上完成一次 45 秒实测：系统正常识别 `HID Keyboard Device` 和 `HID-compliant mouse`，原有 RNDIS 与只读存储同时保留；自动回滚后两个 HID 接口消失，QuickLink 和 Web 服务恢复。测试没有发送任何按键或鼠标报告。

Linux USB Gadget 输出后端会通过 ConfigFS 的设备号匹配 `/dev/hidg*`，不假设键盘和鼠标的节点顺序。当前实机验证命令必须显式指定 `--release-only`：

```bash
sudo env PYTHONPATH=src python3 -m agent_ip_kvm.hid_output_cli --release-only
```

命令会等待 2.5 秒让主机完成 USB 接口配置，然后只发送 8 字节键盘全零报告和 4 字节鼠标全零报告。RDK X5 实测写入成功，随后 45 秒看门狗恢复原 Gadget；尚未开放命令行有效输入。

## 启动最小 Web 界面

页面骨架能够显示视频源状态、固定顶部工具栏和设备信息面板：

```bash
PYTHONPATH=src python -m agent_ip_kvm.web \
  --host 127.0.0.1 \
  --port 8080 \
  --source synthetic
```

使用视频文件源时增加 `--source file --file /path/to/video.mp4`。服务默认只监听本机；在受信的管理网络上访问时，显式指定该网络接口的地址。页面通过 MJPEG 持续显示画面；视频结束、源断开或编码失败时切换为 `No Signal`，点击刷新按钮可以重新连接视频流。

在 Linux 开发板上使用 UVC 采集设备：

```bash
PYTHONPATH=src python -m agent_ip_kvm.web \
  --host 192.168.128.10 \
  --port 8765 \
  --source v4l2 \
  --device /dev/video0 \
  --width 1920 \
  --height 1080 \
  --fps 30
```

V4L2 Web 源当前要求采集设备提供 MJPEG。采集帧会直接进入浏览器 MJPEG 流，不经过额外视频编码。

UGREEN 25854 的 USB 标识为 `2b89:5854`。在 Linux 开发板上安装保持唤醒规则：

```bash
sudo sh scripts/install-uvc-power-rule.sh 2b89 5854
```

规则只匹配指定 USB 标识，并立即把当前匹配设备设为 `power/control=on`。如需撤销：

```bash
sudo sh scripts/install-uvc-power-rule.sh --remove
```

顶部栏显示刷新、鼠标、键盘、屏幕和设置按钮，不显示项目标题或品牌图标。视频区域左下角的两个按钮可把浏览器画面缩放到 50% 至 200%；屏幕菜单只选择采集设备实际支持的 MJPEG 分辨率和刷新率。缩放画面不会移动顶部工具栏或左下角按钮。鼠标菜单可以调整画面内的光标大小。网页打开且 HID 可用时，鼠标一进入实际视频画面就会自动把位置换算为绝对坐标，并同步位置、点击和滚轮，不需要点击开始按钮。键盘按钮会打开触屏屏幕键盘。

Linux 上默认使用 `auto` 后端：USB 主机已配置 Gadget 且键盘、绝对指针端点均可写时，页面自动启用 HID；相对鼠标端点允许缺省。断开时会释放输入并恢复为未连接。为 Web 服务账号安装端点权限规则：

```bash
sudo sh scripts/install-hid-access-rule.sh sunrise
```

撤销规则使用 `sudo sh scripts/install-hid-access-rule.sh --remove`。该规则只改变 `/dev/hidg*` 的所有者和权限，不创建或重绑 USB Gadget。开发阶段也可以显式启用内存模拟后端，验证界面和输入生命周期而不控制连接的电脑：

```bash
PYTHONPATH=src python -m agent_ip_kvm.web \
  --host 127.0.0.1 \
  --port 8080 \
  --source synthetic \
  --enable-hid \
  --hid-backend simulated
```

Linux USB Gadget 后端需要已经存在的 `hid.keyboard` 和 `hid.mouse` ConfigFS 功能；上述持久化服务可以在 RDK X5 上自动建立它们。正式环境开放真实输入前仍需完成认证和单一控制者机制。

RDK X5 已完成一次受保护的真实 Web 键盘验证：开发板通过 Wi-Fi 保持独立管理，QuickLink Type-C 连接目标笔记本；180 秒自动回滚窗口内发送一个小写 `a`，并由 HDMI 回传画面确认字符进入空白记事本。验证后提前回滚，Web HID 自动回到断开状态。

在 RDK X5 上安装 Web 开机服务：

```bash
sudo sh scripts/install-web-service.sh sunrise /home/sunrise/agent-ip-kvm-app
```

服务监听 `0.0.0.0:8765`，使用 `/dev/video0` 的 1920×1080、30 fps MJPEG，并在异常退出后自动重启。使用 `sudo sh scripts/install-web-service.sh --remove` 可以撤销。RDK X5 已完成实际重启验证，Web 与 HID Gadget 服务均会自动恢复。

## 计划架构

```text
用户界面 / API
      │
权限策略与审计 ── Agent 编排
      │
平台无关 KVM 核心
      │
┌─────┴──────────────┐
│                    │
视频采集适配层    USB HID 适配层
│                    │
UVC / CSI / 其他   ConfigFS / MCU / 其他
      │
RDK X5、树莓派及其他 Linux 开发板
```

第一版只验证真实画面采集、有限状态识别和只读建议。修改 BIOS、磁盘分区、系统安装等高风险操作必须展示具体计划，并由用户明确批准后才能执行。

## 文档

- [项目计划](outputs/IP_KVM_项目计划.md)
- [需求文档](docs/REQUIREMENTS.md)
- [项目历史](docs/HISTORY.md)

## 开源许可

本项目采用 [Apache License 2.0](LICENSE)。
