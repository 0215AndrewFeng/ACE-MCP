# ace-mcp Release Checklist

## v4.10.10（当前发布状态）

v4.10.10 的 source、annotated tag、Gitee/GitHub 双远端推送和两端 Release 资产状态必须以实际结果为准。Windows ZIP 和 `release:smoke` 仍待 Windows x64 + Node.js 22 环境完成，不得把当前 Darwin 验证记录成跨平台门禁通过。

当前候选状态（2026-08-28）：

- 符号枚举、强制刷新和入口透传的聚焦 RED/GREEN 已通过；全量测试 399/399、built worker 34/34、构建、tgz 打包、安全扫描、installer 语法、doctor、diff check 与 8/16/32 并发门禁均通过。发布 commit/tag、双端 Release 和本机升级仍按本清单继续执行。
- 12 个低分或失败摘要已使用 `force: true` 修复，随后顺序生成 23 个缺失摘要；35/35 均首轮成功，共 150 个模块、1381 个关键符号、0 failure marker，复评分全部为 A（95.2-100）。
- 只上传本机完整验证通过的 `ace-mcp-4.10.10.tgz`；Windows ZIP 未通过对应平台门禁时不得上传。
- 当前 tgz SHA-256 为 `6dc0d8064baf01c459b97c2f52a4ca337a80a8c2ea79d29d6de29aaf1526f3ae`；提交前若任何打包输入变化，必须重新打包并更新该值。

Windows 产物补齐后，在 Windows x64 + Node.js 22 主机运行 `npm run release:check` 可串行执行完整组合门禁。该命令包含 `release:win` 和 Windows ZIP smoke，因此 Darwin 主机应按下文分别运行可用门禁，不能把部分通过记录成完整 release check 通过。

1. 确认版本号已同步到 `package.json`、`package-lock.json`、`src/version.ts`、README 与 CHANGELOG。
2. 运行质量门禁：

```bash
npm test
npm run test:dist-worker
npm run build
node dist/index.js --version
node dist/index.js --doctor
bash -n scripts/install-macos.sh
```

3. 生成 npm/tgz 包：

```bash
npm run release:pack
```

`release:pack` 默认使用仓库内 `.npm-cache/`，避免本机全局 npm cache 权限问题影响打包。

4. 在 Windows x64 + Node.js 22 环境生成自包含 Windows zip 包：

```bash
npm run release:win
```

打包器必须使用 Node.js 22，且当前 `node_modules` 中必须已有可加载的 `better-sqlite3` 原生绑定。产物会内置同一个 `node.exe`、裁剪后的生产依赖和根目录启动脚本，不在用户机器执行 npm 安装。

截至本清单更新时尚未补齐 v4.10.10 Windows ZIP；必须稍后在 Windows x64 + Node.js 22 主机执行构建、原生绑定加载和 smoke 验证，Darwin 主机结果不能替代该门禁。

5. 检查 Gitee token 是否误入源码、git history 或打包产物。该命令不会打印 token 内容：

```bash
npm run security:secrets
```

6. 运行安装包 smoke test 与 benchmark smoke：

```bash
npm run release:smoke
npm run release:benchmark
```

`release:smoke` 会临时全局安装当前 tgz；同时把 Windows ZIP 解压到隔离目录，在 PATH 不包含 Node/npm 的条件下验证 `ace-mcp --version`、`ace-mcp --doctor`、`ace-mcp-web` 与 `/health`。
`release:benchmark` 启动隔离临时 Web 服务与 full index，并分别执行 8/16/32 搜索并发。每档必须取得足量非空且稳定的搜索结果，记录 p50/p95/p99、吞吐、queueMs、timeout/error；during-index 还必须观察到 active indexing，取得至少 20 个 `/health` 和至少 20 个 `/api/projects/resolve` 有效样本。search p95/p99 默认不高于 5000ms，health p95 不高于 1000ms，resolve p95 不高于 2000ms，且 watcher retry/circuit、maintenance lease loss/renewal failure 与请求超时均为 0。

对真实运行实例复验：

```bash
npm run benchmark:search -- --base-url http://127.0.0.1:8787 --project /absolute/project/path --query FlowSwitcher --during-index
```

7. 检查包内容：

```bash
tar -tf ace-mcp-4.10.10.tgz > /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/dist/index.js" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/dist/core/storage/sqliteIndexWorker.js" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/dist/web/static/js/app.js" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/dist/web/static/css/main.css" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/install-macos.sh" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/configure-codex.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/verify-release-assets.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/check-secrets.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/publish-gitee-release.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/start-web.cmd" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/README-WINDOWS.md" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/smoke-release.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/benchmark-search.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/reindex-projects.mjs" /tmp/ace-mcp-tgz-files.txt

unzip -Z1 release/ace-mcp-v4.10.10-win-x64.zip > /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/dist/index.js" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/dist/core/storage/sqliteIndexWorker.js" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/dist/web/static/js/app.js" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/dist/web/static/css/main.css" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/runtime/node.exe" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/node_modules/better-sqlite3/build/Release/better_sqlite3.node" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/ace-mcp.cmd" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/ace-mcp-web.cmd" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/start-web.cmd" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/doctor.cmd" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/README-WINDOWS.md" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.10.10-win-x64/scripts/reindex-projects.mjs" /tmp/ace-mcp-win-files.txt
```

8. 提交、打 tag 并推送：

先核对工作区，只暂存本版本明确涉及的路径；如范围有增减，逐项调整下面的 pathspec，不得使用全仓库无差别暂存：

```bash
git status --short
git add -- \
  CHANGELOG.md README.md ROADMAP.md docs/release-checklist.md \
  package.json package-lock.json \
  scripts/README-WINDOWS.md scripts/benchmark-search.mjs scripts/configure-codex.mjs scripts/install-macos.sh \
  src/config src/core src/index.ts src/server src/test src/version.ts src/web \
  tasks/todo.md
git diff --cached --name-status
git diff --cached --check
git diff --cached
git commit -m "fix: release v4.10.10 summary symbol refresh"
git tag -a v4.10.10 -m "v4.10.10"
git push origin master
git push origin v4.10.10
git push github master
git push github v4.10.10
```

只有在 staged diff 的文件范围和内容均确认属于 v4.10.10、且对应平台门禁完成后，才执行 commit/tag/push。推送后必须分别核对 `origin/master`、`github/master` 和两端 tag peeled commit。

9. 创建 Gitee 与 GitHub Release，保持 title、说明、发布状态和附件一致，并验证真实下载链路：

```bash
GITEE_TOKEN=<your-token> npm run release:publish -- --version 4.10.10
```

`release:publish` 默认会在上传后运行 `release:verify-assets`。如需单独复验：

```bash
npm run release:verify-assets -- --version 4.10.10
```

GitHub 使用 `gh release create v4.10.10 ace-mcp-4.10.10.tgz --repo 0215AndrewFeng/ACE-MCP --title "v4.10.10" --notes-file <release-notes>`；Windows ZIP 未通过平台门禁时，两端都不得上传或声称已验证该资产。
