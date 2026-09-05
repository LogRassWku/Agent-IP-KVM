# UEFI USB 启动测试镜像

这个目录用于生成一个不会读写目标硬盘的 x86_64 UEFI 测试镜像。成功启动后只显示
`Agent IP KVM USB Boot OK`，按任意键返回固件启动菜单。

构建需要 Linux、`gnu-efi`、`mtools` 和 `dosfstools`。例如在 Ubuntu/WSL 中：

```bash
sudo apt install gnu-efi mtools dosfstools
scripts/build-uefi-test-image.sh
```

生成的镜像位于 `work/uefi-test/agent-ip-kvm-uefi-test.img`，其中包含
`EFI/BOOT/BOOTX64.EFI`，并带有标准 MBR 分区项，兼容只显示分区式可移动介质的固件。镜像只用于测试 USB 启动枚举，不会安装系统。
