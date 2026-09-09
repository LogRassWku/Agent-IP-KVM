# Python 兼容性基准

`python-baseline.json` 提取自原 Python 版本的固定提交：
[d669afe36984abe10866f949b17300f578b000cf](https://github.com/LogRassWku/Agent-IP-KVM/tree/d669afe36984abe10866f949b17300f578b000cf)。完整代码保存在 `legacy` 分支。

- `assetSha256`：原 `src/agent_ip_kvm/web_assets/` 中 HTML、CSS 和三个 SVG 的 Git blob 字节的 SHA-256，验证 HTTP 返回的 UI 资源与原版一致，无需复制整套资源。
- `postRoutes`：原 `src/agent_ip_kvm/web.py` 中 `if path not in {` 到 `content_type = self.headers` 之间的 POST 路径白名单，验证原接口仍存在。
- `source`：来源仓库、固定提交及原文件路径，便于追溯。

这些值从 Python 提交提取，不从当前 TypeScript 实现生成。测试时仅读取本地 JSON，不需要 Python、网络、Git 历史或检出 `legacy`。若后续有意改变 UI 或接口，应明确审核兼容性变化，避免直接用当前实现覆盖基准来消除测试失败。
