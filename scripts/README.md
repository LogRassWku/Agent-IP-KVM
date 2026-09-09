# 共用脚本

本目录保留不依赖 Python 的工具。TypeScript 的 Linux Web/HID 服务安装入口在 [`typescript/linux/`](../typescript/linux/)，相关命令和限制见 [TypeScript 使用说明](../typescript/README.md)。

| 脚本 | 用途 |
|---|---|
| `report-windows-host-info.ps1` | 可选的 Windows 主机信息上报探针 |
| `install-hid-access-rule.sh` | Linux HID 设备访问权限规则 |
| `install-usb-network-service.sh` | Linux USB 管理网络服务 |
| `install-uvc-power-rule.sh` | Linux UVC 设备电源规则 |
| `build-uefi-test-image.sh` | 构建独立的 [UEFI 测试工具](../tools/uefi-test/README.md)镜像 |

原 `install-web-service.sh`、`install-hid-gadget-service.sh` 及其 `apply-hid-gadget.sh` 配套实现仅保存在 `legacy` 分支。主分支使用 `typescript/linux/` 下的对应实现。

这些工具按需使用，不参与 Windows 模拟版启动。Linux 配置、服务安装和 UEFI 路径尚未使用 TypeScript 服务完成实机验证；Python 阶段的历史记录不等同于当前硬件验收。
