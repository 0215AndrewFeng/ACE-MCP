# ace-mcp Release Checklist

## v4.9.7

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

4. 生成 Windows zip 包：

```bash
npm run release:win
```

5. 检查 Gitee token 是否误入源码、git history 或打包产物。该命令不会打印 token 内容：

```bash
npm run security:secrets
```

6. 运行安装包 smoke test 与 benchmark smoke：

```bash
npm run release:smoke
npm run release:benchmark
```

`release:smoke` 会临时全局安装当前 tgz，验证 `ace-mcp --version`、`ace-mcp --doctor`、`ace-mcp-web` 与 `/health`。
`release:benchmark` 会启动隔离临时 Web 服务，索引小项目并输出 search/health p95 与事件循环响应性。

7. 检查包内容：

```bash
tar -tf ace-mcp-4.9.7.tgz | rg "package/(dist/index.js|dist/web/static/js/app.js|dist/web/static/css/main.css|scripts/install-macos.sh|scripts/verify-release-assets.mjs|scripts/check-secrets.mjs|scripts/publish-gitee-release.mjs|scripts/start-web.cmd|scripts/README-WINDOWS.md|scripts/smoke-release.mjs|scripts/benchmark-search.mjs|scripts/reindex-projects.mjs)"
unzip -l release/ace-mcp-v4.9.7-win-x64.zip | rg "dist/index.js|dist/web/static/js/app.js|dist/web/static/css/main.css|install.ps1|start-web.cmd|README-WINDOWS.md|benchmark-search.mjs|check-secrets.mjs|publish-gitee-release.mjs|reindex-projects.mjs"
```

8. 提交、打 tag 并推送：

```bash
git add .
git commit -m "feat: release v4.9.7 ide agent actions"
git tag -a v4.9.7 -m "v4.9.7"
git push origin master
git push origin v4.9.7
```

9. 使用 Gitee OpenAPI 创建/更新 Release、替换同名 tgz/Windows zip 附件，并自动验证真实下载链路：

```bash
GITEE_TOKEN=<your-token> npm run release:publish -- --version 4.9.7
```

`release:publish` 默认会在上传后运行 `release:verify-assets`。如需单独复验：

```bash
npm run release:verify-assets -- --version 4.9.7
```
