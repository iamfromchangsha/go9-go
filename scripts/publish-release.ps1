# 发布 Release：把本地构建好的 exe / apk 挂到 GitHub Release
$ErrorActionPreference = 'Continue'
$root = 'D:\minimax\coder\go9'
$tag = if ($args.Count -ge 1) { $args[0] } else { 'v1.0.0' }
$repo = 'iamfromchangsha/go9-go'
$exe = Join-Path $root 'desktop\windows\out\Go9.exe'
$apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'

foreach ($f in @($exe, $apk)) {
    if (Test-Path $f) { Write-Host ("  ✓ {0}  {1:N1} MB" -f (Split-Path $f -Leaf), ((Get-Item $f).Length / 1MB)) }
    else { Write-Host ("  ✗ 缺少 {0}" -f $f); exit 1 }
}

$notes = @"
## 九路围棋 v$tag

- **Go9.exe** — Windows 10/11 桌面版（单文件、免安装；需系统自带 Microsoft Edge WebView2 Runtime）
- **app-debug.apk** — Android 7+ 安装包（debug 签名；安装前需在系统里允许「安装未知来源」）

### 网页版
仓库根目录就是纯静态页面，起个静态服务器即可：

```bash
node server.mjs 8123
```

### 说明
APK 是 Gradle `assembleDebug` 出的调试签名包，可直接安装体验（系统会显示「未知来源」提示）。
若需正式签名版，配置好 keystore 后再跑一次 release 构建即可。

仓库地址：https://github.com/$repo
"@

Write-Host "  创建 Release $tag ..."
$args = @('release', 'create', $tag, $exe, $apk,
          '--repo', $repo,
          '--title', "九路围棋 $tag",
          '--notes', $notes,
          '--target', 'main')
& gh @args
if ($LASTEXITCODE -ne 0) {
    Write-Host '  创建失败，若 Release 已存在则改为覆盖上传 ...'
    & gh release upload $tag $exe $apk --repo $repo --clobber
}
Write-Host "  完成：https://github.com/$repo/releases/tag/$tag"
