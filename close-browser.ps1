# 关闭常驻抓取浏览器（窗口里未提交的验证会丢，但已保存的登录 cookie 不受影响）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$mark = Join-Path $root '.tool-browser.json'
$n = 0
if (Test-Path $mark) {
    try {
        $m = Get-Content $mark -Raw | ConvertFrom-Json
        if ($m.pid -and (Get-Process -Id $m.pid -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $m.pid -Force -ErrorAction SilentlyContinue
            $n++
        }
    } catch {}
    Remove-Item $mark -Force -ErrorAction SilentlyContinue
}
# 兜底：按命令行匹配工具自己的配置目录，把残留的 Chrome 进程一并清掉
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object {
    $_.CommandLine -like ("*" + $root + "\.chrome-profile*")
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $n++
}
if ($n -gt 0) { Write-Host ("已关闭抓取浏览器（结束 $n 个进程）。") }
else { Write-Host "抓取浏览器本来就没在运行。" }
