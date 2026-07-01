# ace-mcp Release Checklist

## v4.8.8

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

5. 运行安装包 smoke test 与 benchmark smoke：

```bash
npm run release:smoke
npm run release:benchmark
```

`release:smoke` 会临时全局安装当前 tgz，验证 `ace-mcp --version`、`ace-mcp --doctor`、`ace-mcp-web` 与 `/health`。
`release:benchmark` 会启动隔离临时 Web 服务，索引小项目并输出 search/health p95 与事件循环响应性。

6. 检查包内容：

```bash
tar -tf ace-mcp-4.8.8.tgz | rg "package/(dist/index.js|scripts/install-macos.sh|scripts/verify-release-assets.mjs|scripts/start-web.cmd|scripts/README-WINDOWS.md|scripts/smoke-release.mjs|scripts/benchmark-search.mjs|scripts/reindex-projects.mjs)"
unzip -l release/ace-mcp-v4.8.8-win-x64.zip | rg "dist/index.js|install.ps1|start-web.cmd|README-WINDOWS.md|benchmark-search.mjs|reindex-projects.mjs"
```

7. 提交、打 tag 并推送：

```bash
git add .
git commit -m "chore: release v4.8.8 install release closure"
git tag -a v4.8.8 -m "v4.8.8"
git push origin master
git push origin v4.8.8
```

8. Gitee Release 页面创建/更新完成并上传 tgz、Windows zip 后，验证真实下载链路：

```bash
npm run release:verify-assets -- --version 4.8.8
```
