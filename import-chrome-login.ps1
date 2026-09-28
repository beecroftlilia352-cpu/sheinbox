# 把「日常 Chrome」里已有的登录态（主要是 cookies）复制到本工具的专属浏览器目录，
# 这样抓取时启动的窗口天生就是已登录状态 —— 不用扫码、不用过滑块。
#
# 用法：import-chrome-login.cmd                    自动识别你最近使用的配置
#       import-chrome-login.cmd -Profile "Profile 1"  指定配置
#       import-chrome-login.cmd -Yes              不问确认，直接复制
param([string]$Profile = '', [switch]$Yes)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$chromeRoot = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$statePath = Join-Path $chromeRoot 'Local State'

if (-not (Test-Path $statePath)) {
    Write-Host "找不到日常 Chrome 的配置目录：$chromeRoot" -ForegroundColor Red
    Write-Host "如果你用的是别的浏览器（Edge 等），这个脚本需要改路径。"
    if (-not $Yes) { Read-Host "按回车关闭" }
    exit 1
}

# 关键：Chrome 可以有多套配置（Default / Profile 1 / Profile 2 …），
# 登录态只在你实际在用的那套里 —— 写死 Default 会导到一套空的。
if (-not $Profile) {
    try {
        $st = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Profile = $st.profile.last_used
    } catch { $Profile = $null }
    if (-not $Profile) { $Profile = 'Default' }
    Write-Host "自动识别到最近使用的配置：$Profile"
}

$chromeProfile = Join-Path $chromeRoot $Profile
if (-not (Test-Path $chromeProfile)) {
    Write-Host "配置目录不存在：$chromeProfile" -ForegroundColor Red
    Write-Host "可选的配置："
    Get-ChildItem -Path $chromeRoot -Directory | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } | ForEach-Object { Write-Host ("  " + $_.Name) }
    if (-not $Yes) { Read-Host "按回车关闭" }
    exit 1
}

$dest = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) '.chrome-profile'

$running = @(Get-Process chrome -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host "提示：Chrome 正在运行（$($running.Count) 个进程）。"
    Write-Host "刚才那次导入就是因为选错配置才没拿到登录态；运行时复制本身通常没问题。"
    if (-not $Yes) {
        $ans = Read-Host "继续？(y/N)"
        if ($ans -ne 'y') { Write-Host "已取消。"; exit 0 }
    }
}

New-Item -ItemType Directory -Force -Path (Join-Path $dest 'Default\Network') | Out-Null

# Local State 存着解密 cookies 用的密钥（本机同一用户 + 同一个 chrome.exe 才能解）
$pairs = @(
    @{ from = (Join-Path $chromeRoot    'Local State');                 to = (Join-Path $dest 'Local State');                     name = 'Local State' },
    @{ from = (Join-Path $chromeProfile 'Network\Cookies');             to = (Join-Path $dest 'Default\Network\Cookies');         name = 'Cookies' },
    @{ from = (Join-Path $chromeProfile 'Network\Cookies-wal');         to = (Join-Path $dest 'Default\Network\Cookies-wal');     name = 'Cookies-wal' },
    @{ from = (Join-Path $chromeProfile 'Network\Cookies-shm');         to = (Join-Path $dest 'Default\Network\Cookies-shm');     name = 'Cookies-shm' },
    @{ from = (Join-Path $chromeProfile 'Preferences');                 to = (Join-Path $dest 'Default\Preferences');             name = 'Preferences' },
    @{ from = (Join-Path $chromeProfile 'Login Data');                  to = (Join-Path $dest 'Default\Login Data');              name = 'Login Data' }
)

$copied = 0
foreach ($p in $pairs) {
    if (Test-Path -LiteralPath $p.from) {
        try {
            Copy-Item -LiteralPath $p.from -Destination $p.to -Force -ErrorAction Stop
            Write-Host ("  复制 " + $p.name)
            $copied++
        } catch {
            Write-Host ("  跳过 " + $p.name + "（" + $_.Exception.Message + "）") -ForegroundColor Yellow
        }
    }
}

foreach ($sub in @('Local Storage', 'Session Storage')) {
    $src = Join-Path $chromeProfile $sub
    if (Test-Path -LiteralPath $src) {
        $dst = Join-Path $dest ('Default\' + $sub)
        try {
            Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force -ErrorAction Stop
            Write-Host ("  复制 " + $sub)
            $copied++
        } catch {
            Write-Host ("  跳过 " + $sub + "（" + $_.Exception.Message + "）") -ForegroundColor Yellow
        }
    }
}

Write-Host ""
if ($copied -eq 0) {
    Write-Host "什么都没复制到 —— 检查上面的跳过原因。" -ForegroundColor Red
} else {
    Write-Host "完成（配置 $Profile，共 $copied 项）。"
    Write-Host "接下来：回到页面点「读取商品」。如果弹出的窗口直接是商品页，说明登录态已生效。"
    Write-Host "如果仍然停在登录页/验证码：说明那套配置里本来就没有 1688 的登录态，"
    Write-Host "或者 Chrome 的 App-Bound Encryption 不允许跨目录解密 —— 那就只能在工具窗口里登录一次。"
    Write-Host ""
    Write-Host "想撤销：删掉 $dest 目录即可（工具会回到全新未登录状态）。"
}
if (-not $Yes) { Read-Host "按回车关闭" }
