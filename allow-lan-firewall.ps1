# 放行 8901 给局域网（需要管理员：会在 UAC 里请你点“是”）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ruleName = "SHEIN选品定价台 8901"
$port = 8901

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "需要管理员权限才能改防火墙，正在弹出 UAC 授权窗口，请点“是” ..."
    $args = '-NoProfile -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Definition + '"'
    Start-Process powershell -Verb RunAs -ArgumentList $args
    exit
}

Write-Host "正在为 $port 端口添加局域网入站放行规则 ..."
netsh advfirewall firewall delete rule name="$ruleName" | Out-Null
netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$port profile=any | Out-Null

$rule = netsh advfirewall firewall show rule name="$ruleName" 2>$null
if ($rule -match "$port") {
    Write-Host ""
    Write-Host "完成。局域网用户现在可以访问： http://本机IP:$port/"
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike '*VMware*' } |
        Select-Object -First 1).IPAddress
    if ($ip) { Write-Host "本机局域网地址： http://${ip}:$port/" }
    Write-Host ""
    Write-Host "建议再双击 verify-autostart.cmd 跑一遍自检。"
} else {
    Write-Host "添加失败，请把上面的报错发我。"
}
Write-Host ""
Read-Host "按回车关闭"
