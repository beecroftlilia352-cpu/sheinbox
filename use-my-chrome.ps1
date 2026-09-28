# 让抓取直接在你自己的 Chrome 里新开标签页（不弹新窗口）
#
# 原理：Chrome 只有在**启动时**带 --remote-debugging-port 才能被外部程序接管。
#       你正在用的 Chrome 没带这个参数，所以本脚本要 ① 你完全退出 Chrome
#       ② 用它带的参数把你的 Chrome 重新打开（配合 --restore-last-session，标签页会恢复）。
#       之后抓取就只在你这个浏览器里新开标签页，用你自己的登录态与历史。
#
# 用法：双击 use-my-chrome.cmd（= 本脚本）。已经开着带调试端口的 Chrome 时，直接提示成功。
#      想让我强制关掉现有 Chrome 再重开：use-my-chrome.cmd -Restart（未保存的表单可能丢）
param([switch]$Restart, [switch]$Yes)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PORT = 9223
$MARK = Join-Path $root '.use-my-chrome.json'

function Port-Alive([int]$p) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$p/json/version" | Out-Null; return $true } catch { return $false }
}

$chrome = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Host '没找到 Chrome。' -ForegroundColor Red; exit 1 }

$userData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
if (-not (Test-Path $userData)) { Write-Host "没找到 Chrome 用户目录：$userData" -ForegroundColor Red; exit 1 }

# 最近使用的配置（Default / Profile 1 …）
$profDir = 'Default'
try {
    $ls = Get-Content (Join-Path $userData 'Local State') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ls.profile.last_used) { $profDir = $ls.profile.last_used }
} catch {}

if (Port-Alive $PORT) {
    Write-Host "已经就绪：你的 Chrome 现在就带调试端口在跑（端口 $PORT）。" -ForegroundColor Green
    Write-Host "之后在定价台点「读取商品」，只会在这个浏览器里新开一个标签页。"
    exit 0
}

$running = @(Get-Process chrome -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    if (-not ($Restart -and $Yes)) {
        Write-Host "Chrome 正在运行（$($running.Count) 个进程），但没带调试端口 —— 需要先完全退出它。" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "请这样做（**你自己关，我不会碰你的浏览器**）：" -ForegroundColor Yellow
        Write-Host "  1) 关掉所有 Chrome 窗口（确认任务管理器里没有 chrome.exe 残留）"
        Write-Host "  2) 再双击一次本脚本（或 use-my-chrome.cmd）"
        Write-Host ""
        Write-Host "想让脚本替你关：use-my-chrome.cmd -Restart -Yes" -ForegroundColor DarkGray
        Write-Host "  ⚠ 那会关掉 Chrome 再重开：**所有标签页会重新加载**，正在填的表单、正在扫的码都会丢。" -ForegroundColor DarkGray
        if ($Restart -and -not $Yes) {
            Write-Host ""
            Write-Host "你给了 -Restart 但没给 -Yes —— 为安全起见什么都不做。确认要这么做就加 -Yes。" -ForegroundColor Yellow
        }
        exit 1
    }
    Write-Host "⚠ 正在按你的明确要求关闭 Chrome 并重开（所有标签页会重新加载）…" -ForegroundColor Yellow
    Start-Sleep -Seconds 3
    Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

Write-Host "正在以「带调试端口」的方式重开你的 Chrome（配置 $profDir）…"
$p = Start-Process -FilePath $chrome -PassThru -ArgumentList @(
    "--remote-debugging-port=$PORT",
    "--user-data-dir=$userData",
    "--profile-directory=$profDir",
    '--restore-last-session',
    '--no-first-run', '--no-default-browser-check'
)

$ok = $false
foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 500
    if (Port-Alive $PORT) { $ok = $true; break }
    if ($p.HasExited) { break }
}
if (-not $ok) {
    Write-Host "没能开起来（端口 $PORT 没响应）。多半是还有 Chrome 进程在跑；" -ForegroundColor Red
    Write-Host "确认完全退出后再试，或用 use-my-chrome.cmd -Restart。" -ForegroundColor Red
    exit 1
}

@{ port = $PORT; pid = $p.Id; profile = $profDir; userDataDir = $userData } |
    ConvertTo-Json | Set-Content -Path $MARK -Encoding UTF8
Write-Host "完成 ✅ 你的 Chrome 现在带调试端口在跑（端口 $PORT，配置 $profDir）。" -ForegroundColor Green
Write-Host "之后在定价台点「读取商品」：只会在你这个浏览器里新开标签页，不弹新窗口。"
Write-Host "提示：调试端口只监听本机；关掉 Chrome 即失效（想恢复原样，正常方式打开 Chrome 即可）。" -ForegroundColor DarkGray
