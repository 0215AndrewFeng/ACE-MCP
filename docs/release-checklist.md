# ace-mcp Release Checklist

## v4.6.8

1. 确认版本号已同步到 `package.json`、`package-lock.json`、`src/version.ts`、README 与 CHANGELOG。
2. 运行质量门禁：

```bash
npm test
npm run build
node dist/index.js --version
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

5. 检查包内容：

```bash
tar -tf ace-mcp-4.6.8.tgz | rg "package/(dist/index.js|scripts/start-web.cmd|scripts/README-WINDOWS.md)"
unzip -l release/ace-mcp-v4.6.8-win-x64.zip | rg "dist/index.js|install.ps1|start-web.cmd|README-WINDOWS.md"
```

6. 提交并打 tag：

```bash
git add .
git commit -m "chore: release v4.6.8 windows package"
git tag -a v4.6.8 -m "v4.6.8"
git push origin master
git push origin v4.6.8
```
