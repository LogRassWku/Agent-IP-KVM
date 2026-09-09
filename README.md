# Agent IP KVM

面向 Linux 开发板的智能 IP KVM，通过视频采集、USB HID 和 Agent 协作，远程观察并受控操作电脑。

默认分支 `main` 使用 TypeScript，当前优先支持 Windows 模拟运行，保留原 UI 和交互。完整原 Python 版本保存在 [`legacy` 分支](https://github.com/LogRassWku/Agent-IP-KVM/tree/legacy)。**TypeScript 的 Linux / RDK X5 硬件路径尚未经过实机验证**，历史 Python 实测记录不能视为 TypeScript 的验证结果。

## Windows 快速开始

需要 Node.js 22.12+。在仓库根目录运行：

```powershell
npm ci
npm run build
npm start -- --source synthetic --enable-hid --hid-backend simulated
```

打开 <http://127.0.0.1:8080>。模拟版提供彩条视频和内存中的键鼠事件，无需 Python 或开发板；运行数据默认写入 `data/typescript/`。

## 开发与测试

首次运行浏览器测试前安装 Chromium：

```powershell
npx playwright install chromium
npm run check
```

`check` 包含类型检查、构建、后端测试和浏览器交互测试。具体测试范围与实机待验项目见 [验证记录](typescript/VALIDATION.md)。

## 目录导航

| 路径 | 用途 |
|---|---|
| `typescript/src/` | 当前服务端与硬件适配代码 |
| `typescript/ui/` | 浏览器端代码与原 UI 资源 |
| `typescript/tests/`、`typescript/e2e/` | TypeScript 后端与浏览器测试 |
| `typescript/templates/` | 运行时模板、HID 描述符和恢复包资源 |
| `typescript/linux/` | TypeScript 版 Linux 安装脚本，待实机验证 |
| `docs/` | 文档索引、设计资料、项目计划与 Python 历史说明 |
| `typescript/tests/fixtures/` | 从固定 Python 提交提取的兼容性基准：资源校验值与接口清单 |
| `scripts/` | 共用 Linux 配置脚本、Windows 主机探针及 UEFI 镜像构建工具；详见[脚本说明](scripts/README.md) |
| `tools/uefi-test/` | UEFI 测试程序源码与说明 |
| `.github/workflows/` | Windows / Linux 自动化检查 |

`package.json`、`tsconfig.json` 和 `playwright.config.ts` 位于根目录，所有 npm 命令也在这里执行。Python 源码、测试和专用安装脚本仅保存在 `legacy` 分支；`main` 的构建与测试无需检出 Python 版本。

本地生成内容不参与版本管理：`node_modules/` 为依赖，`dist/` 为构建结果，`work/` 为测试报告和临时文件，`data/`、`runtime/` 为运行数据，`outputs/captures/` 为本地截图。项目计划等长期文档统一放在 `docs/`。

## 文档

- [TypeScript 使用说明](typescript/README.md)：完整功能、配置与 Linux 适配说明。
- [验证记录](typescript/VALIDATION.md)：自动化验证范围及已知限制。
- [文档索引](docs/README.md)：设计、需求、项目计划与历史记录。
- [Python 历史说明](docs/PYTHON_LEGACY.md)：原版运行方式与实机记录。

## 开源许可

本项目采用 [Apache License 2.0](LICENSE)。
