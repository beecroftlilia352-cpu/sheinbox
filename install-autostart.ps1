# 创建/删除「开机自启」快捷方式（放进当前用户的启动文件夹，不需要管理员）
# 目标：pythonw.exe server.py  —— pythonw 是无控制台版本，登录后静默常驻，不弹黑窗口
param([switch]$Remove)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$proj = Split-Path -Parent $MyInvocation.MyCommand.Definition
$py = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\pythonw.exe'
if (-not (Test-Path $py)) { $py = 'pythonw.exe' }
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'SHEIN选品定价台.lnk'

if ($Remove) {
    if (Test-Path $lnk) {
        Remove-Item $lnk -Force
        Write-Host "已删除开机自启：$lnk"
    } else {
        Write-Host "启动文件夹里没有这项，无需删除。"
    }
    exit 0
}

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = $py
$s.Arguments = '"' + (Join-Path $proj 'server.py') + '"'
$s.WorkingDirectory = $proj
$s.WindowStyle = 7                      # 最小化（pythonw 本身无窗口，这里只是双保险）
$s.Description = 'SHEIN 选品定价台（本地服务，端口 8901，局域网可访问）'
$s.Save()

Write-Host "已创建开机自启："
Write-Host "  $lnk"
Write-Host "  目标：$py"
Write-Host "  参数：`"$(Join-Path $proj 'server.py')`""
Write-Host ""
Write-Host "登录 Windows 后会自动在后台（无窗口）启动服务。"
Write-Host "自检：双击 verify-autostart.cmd      取消：双击 uninstall-autostart.cmd"
