# 打开「常驻抓取浏览器」（不抓取，只是把那个窗口打开 / 提到前面）
#
# 用途：先在这个窗口里把 1688 的验证码/登录处理掉，之后再点「读取商品」就一路畅通。
# 这个窗口是独立进程：抓取结束、超时、甚至停服务／重启服务，它都不会被关掉。
# 想关掉它 = 直接关掉那个浏览器窗口（或运行 close-browser.cmd）。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

$chrome = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { Write-Host '没找到 Chrome，无法打开抓取浏览器。' -ForegroundColor Red; exit 1 }

$mark = Join-Path $root '.tool-browser.json'
$port = $null
if (Test-Path $mark) {
    try {
        $m = Get-Content $mark -Raw | ConvertFrom-Json
        if ($m.port -and (Get-Process -Id $m.pid -ErrorAction SilentlyContinue)) {
            try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$($m.port)/json/version" | Out-Null; $port = $m.port } catch {}
        }
    } catch {}
}

if ($port) {
    Write-Host "抓取浏览器已经在跑（调试端口 $port）。" -ForegroundColor Green
    Write-Host "请直接切到那个 Chrome 窗口（任务栏里带 1688 页面的那个）处理验证/登录。"
    exit 0
}

Write-Host "正在打开抓取浏览器 …（这个窗口会一直留着，验证一次以后都够用）"
Start-Process -FilePath $chrome -ArgumentList @(
    '--remote-debugging-port=9222',
    "--user-data-dir=$root\.chrome-profile",
    '--start-maximized', '--no-first-run', '--no-default-browser-check', '--lang=zh-CN',
    'https://www.1688.com/'
) | Out-Null
Write-Host "已打开。在这个窗口里登录 1688（或过掉验证码），然后回到定价台点「读取商品」。"
