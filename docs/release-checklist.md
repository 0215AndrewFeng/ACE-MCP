# ace-mcp Release Checklist

## v4.9.11

1. 确认版本号已同步到 `package.json`、`package-lock.json`、`src/version.ts`、README 与 CHANGELOG。
2. 运行质量门禁：

```bash
npm test
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
`release:benchmark` 会启动隔离临时 Web 服务，索引小项目并输出 search/health p95 与事件循环响应性。

7. 检查包内容：

```bash
tar -tf ace-mcp-4.9.11.tgz > /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/dist/index.js" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/dist/web/static/js/app.js" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/dist/web/static/css/main.css" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/install-macos.sh" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/verify-release-assets.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/check-secrets.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/publish-gitee-release.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/start-web.cmd" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/README-WINDOWS.md" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/smoke-release.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/benchmark-search.mjs" /tmp/ace-mcp-tgz-files.txt
rg -Fx "package/scripts/reindex-projects.mjs" /tmp/ace-mcp-tgz-files.txt

unzip -Z1 release/ace-mcp-v4.9.11-win-x64.zip > /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/dist/index.js" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/dist/web/static/js/app.js" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/dist/web/static/css/main.css" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/runtime/node.exe" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/node_modules/better-sqlite3/build/Release/better_sqlite3.node" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/ace-mcp.cmd" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/ace-mcp-web.cmd" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/start-web.cmd" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/doctor.cmd" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/README-WINDOWS.md" /tmp/ace-mcp-win-files.txt
rg -Fx "ace-mcp-v4.9.11-win-x64/scripts/reindex-projects.mjs" /tmp/ace-mcp-win-files.txt
```

8. 提交、打 tag 并推送：

```bash
git add .
git commit -m "feat: release v4.9.11 runtime data health"
git tag -a v4.9.11 -m "v4.9.11"
git push origin master
git push origin v4.9.11
```

9. 使用 Gitee OpenAPI 创建/更新 Release、替换同名 tgz/Windows zip 附件，并自动验证真实下载链路：

```bash
GITEE_TOKEN=<your-token> npm run release:publish -- --version 4.9.11
```

`release:publish` 默认会在上传后运行 `release:verify-assets`。如需单独复验：

```bash
npm run release:verify-assets -- --version 4.9.11
```
