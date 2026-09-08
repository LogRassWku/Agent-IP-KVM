# Agent IP KVM 本地恢复说明

此文件包只用于未来的 USB HID 重绑实验。生成文件时没有修改 USB。

## 实验前必须满足

1. 通过串口、本地终端或其他不依赖 USB QuickLink 的方式登录开发板。
2. 保持该本地会话处于打开状态，并确认能够执行管理员命令。
3. 在当前状态下运行 `./preflight.sh`，只有显示 `PASS` 才能继续。
4. 先运行 `./rollback.sh` 查看默认预览；它不会修改 USB。
5. `temporary-apply.sh` 只用于短时枚举测试，必须显式传入 `--apply`，并会自动调用回滚脚本。

## 需要恢复时

在独立的本地会话中运行：

```bash
sudo ./rollback.sh --apply
```

脚本只尝试删除 `__GADGET__`／`__CONFIG__` 中的
`hid.keyboard`、`hid.mouse`、`hid.pointer` 和 `hid.power`，然后重新绑定 `__UDC__`。它不会删除
现有的 __EXISTING__。

如果 Gadget 名称、UDC 或现有功能已变化，不要使用旧文件包，应重新探测并生成。
