# Agent IP KVM

Agent IP KVM 是一个面向多种 Linux 开发板的开源智能 IP KVM 项目。项目计划通过视频采集、USB HID、权限控制和 Agent 协作，让用户远程观察并受控操作电脑的操作系统、安装环境和 BIOS／UEFI。

RDK X5 是第一个开发与验证平台，但核心软件不绑定单一型号。不同开发板通过适配层接入各自的视频采集、USB Gadget、硬件加速和系统管理能力。

## 当前状态

项目处于视频输入基础层验证阶段：

- RDK X5 基础系统和远程管理链路已验证。
- 一款已确认故障的 USB UVC 采集卡可用于验证设备枚举和能力查询，但不能作为真实画面基线。
- 已建立平台无关的视频源接口，并以 1280×720、30 fps 的模拟视频源跑通取帧、状态和错误处理。
- Agent、浏览器界面和 HID 控制尚未开始实现。

当前状态会如实记录，不把设备枚举成功视为视频链路成功。

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

当前 RDK X5 实测能够把故障采集卡的 `/dev/video0` 识别为视频采集节点，并把 `/dev/video1` 识别为元数据节点。设备声明成功不代表能够取得真实帧。

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
