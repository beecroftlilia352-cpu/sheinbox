# 停止 SHEIN 选品定价台（连抓取用的 node 进程一起清掉）
# 注意：停服务会把“正在跑的那次抓取”连着它弹出的浏览器窗口一起杀掉。
# 所以有人在过验证码/登录时不要停 —— 除非明确加 -Force。
param([switch]$Force)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Host "正在停止 SHEIN 选品定价台 ..."
$me = $PID

if (-not $Force) {
    $busy = $false
    try {
        $h = Invoke-RestMethod -TimeoutSec 3 http://127.0.0.1:8901/api/health
        $busy = [bool]$h.running
    } catch {}
    if ($busy) {
        Write-Host "⚠ 现在有抓取任务在跑（如果你正在过验证码/登录，停了那个浏览器窗口会一起消失）。" -ForegroundColor Yellow
        Write-Host "  确实要停：stop-service.cmd -Force" -ForegroundColor Yellow
        exit 1
    }
}

$killed = 0
Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $me -and
    $_.Name -in @('python.exe','pythonw.exe','node.exe') -and
    $_.CommandLine -and ($_.CommandLine -match 'server\.py|fetch-1688')
} | ForEach-Object {
    Write-Host ("  结束 " + $_.Name + " pid=" + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
}
Start-Sleep -Seconds 1
$alive = $false
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8901/api/health | Out-Null; $alive = $true } catch {}
if ($alive) {
    Write-Host "端口仍在响应 —— 可能有别的程序占用 8901，或手动启动的实例还在。"
} elseif ($killed -eq 0) {
    Write-Host "服务本来就没在运行。"
} else {
    Write-Host "已停止（共结束 $killed 个进程）。"
}
Write-Host "注意：只是停本次运行；下次登录仍会自启。要彻底取消请双击 uninstall-autostart.cmd"
