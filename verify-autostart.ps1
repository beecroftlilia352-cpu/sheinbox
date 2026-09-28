# 开机自启自检：检查快捷方式 + 用与开机完全相同的方式启动一次 + 检查局域网可达性
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$proj = Split-Path -Parent $MyInvocation.MyCommand.Definition
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'SHEIN选品定价台.lnk'
$py = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\pythonw.exe'
if (-not (Test-Path $py)) { $py = 'pythonw.exe' }
$ok = $true

function Probe($url) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 $url | Out-Null; return $true } catch { return $false }
}

Write-Host "==============================================="
Write-Host " SHEIN 选品定价台 —— 开机自启自检"
Write-Host "==============================================="

Write-Host "[1/4] 启动文件夹里的自启快捷方式"
if (Test-Path $lnk) {
    Write-Host "      OK  $lnk"
} else {
    Write-Host "      失败：没找到自启项，请先双击 install-autostart.cmd"
    $ok = $false
}

Write-Host "[2/4] 本机服务 http://127.0.0.1:8901/"
$running = Probe 'http://127.0.0.1:8901/api/health'
if ($running) { Write-Host "      OK  已在运行" } else { Write-Host "      ·   未运行，现在按开机方式启动一次" }

if (-not $running) {
    Write-Host "[3/4] 等待就绪（最多 20 秒）"
    Start-Process -FilePath $py -ArgumentList ('"' + (Join-Path $proj 'server.py') + '"') -WorkingDirectory $proj
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 2
        if (Probe 'http://127.0.0.1:8901/api/health') { $running = $true; break }
    }
    if ($running) { Write-Host "      OK  启动成功（说明开机时同样能起来）" }
    else { Write-Host "      失败：20 秒内没起来，看看 logs\server.log"; $ok = $false }
} else {
    Write-Host "[3/4] 跳过启动（已在运行）"
}

Write-Host "[4/4] 局域网可达性"
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike '*VMware*' } |
    Select-Object -First 1).IPAddress
if ($ip) {
    if (Probe "http://${ip}:8901/api/health") { Write-Host "      OK  监听生效：http://${ip}:8901/" }
    else { Write-Host "      失败：本机经局域网地址都连不上，检查端口占用"; $ok = $false }
} else {
    Write-Host "      ·   没找到局域网 IP（网线/无线是否断了？）"
}
$rule = netsh advfirewall firewall show rule name="SHEIN选品定价台 8901" 2>$null
if ($rule -match '8901') {
    Write-Host "      OK  防火墙已放行 8901（局域网其他电脑可以访问）"
} else {
    Write-Host "      待办：防火墙还没放行 —— 局域网其他电脑会连不上。请双击 allow-lan-firewall.cmd，UAC 点“是”。"
    $ok = $false
}

Write-Host ""
if ($ok) {
    Write-Host "结论：全部通过。"
    Write-Host "局域网地址（发给同事）： http://${ip}:8901/"
} else {
    Write-Host "结论：有未通过项，按上面的提示处理即可。"
}
