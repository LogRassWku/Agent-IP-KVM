# 被控主机信息

Agent IP KVM 不能从 HDMI 视频或 USB HID 直接读取操作系统和硬件清单。项目使用一个可选的被控端只读信息探针采集数据，通过局域网发送给开发板。

## 数据流

1. 被控主机运行 `scripts/report-windows-host-info.ps1`。
2. 脚本通过 Windows CIM 读取系统、整机、BIOS、CPU、GPU、内存、磁盘、卷和网络地址。
3. 脚本将 JSON 发送至开发板的 `POST /api/host-info`。
4. 开发板验证数据结构后，原子写入 `data/controlled-host.json`。
5. KVM 设置面板与未来的板载 Agent 读取同一份缓存。

运行数据文件位于项目目录内，但被 `.gitignore` 排除，不会提交个人设备信息。

## Windows 一次性采集

在被控 Windows 主机的项目目录中运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/report-windows-host-info.ps1 -KvmUrl http://开发板地址:8765
```

当前脚本只执行一次，不创建服务、不修改系统配置。后续 PC Agent 可以定时调用相同采集逻辑，并在卸载时停止上报。

## JSON 版本

当前 `schema_version` 为 `1`。字段包括：

- 采集时间和主机名
- 操作系统版本、构建号、架构和上次启动时间
- 设备厂商与型号
- BIOS 厂商、版本、日期和安全启动状态
- CPU 型号、物理核心、逻辑处理器和最高频率
- 内存总量、内存条容量、频率、厂商和型号
- GPU 名称、驱动版本和显存报告值
- 物理磁盘型号、接口和容量
- 本地卷盘符、卷标、文件系统、容量和可用空间
- 当前启用网络接口的 IP 地址
