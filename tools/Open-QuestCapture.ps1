param(
    [ValidateRange(1, 65535)][int]$Port = 52393,
    [ValidateRange(1, 65535)][int]$WifiPort = 52394,
    [string]$Address,
    [switch]$Usb
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$url = "http://127.0.0.1:$Port/"
function Test-CaptureServer {
    try {
        $page = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
        return $page.Headers['X-Host-Management-Version'] -eq '11'
    } catch { return $false }
}
if (!(Test-CaptureServer)) {
    if (Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $Port -ErrorAction SilentlyContinue) {
        throw "Restart the host server on port $Port with the current serve.py."
    }
    $python = (Get-Command python.exe).Source
    $process = Start-Process -FilePath $python -ArgumentList @('serve.py', '--port', $Port) -WorkingDirectory $root -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 20; $i++) {
        if ($process.HasExited -or (Test-CaptureServer)) { break }
        Start-Sleep -Milliseconds 200
    }
    if ($process.HasExited -or !(Test-CaptureServer)) { throw "Could not start the capture server on port $Port." }
}
if ($Usb) {
    $adb = (Get-Command adb.exe -ErrorAction SilentlyContinue).Source
    if (!$adb) { $adb = Join-Path $env:ProgramFiles 'platform-tools/adb.exe' }
    $mappings = & $adb reverse --list
    if ($LASTEXITCODE) { throw 'Connect the Quest by USB and allow USB debugging.' }
    if ($mappings -match " tcp:${Port} tcp:${Port}$") {
        & $adb reverse --remove "tcp:$Port"
        if ($LASTEXITCODE) { throw 'Could not remove the old host-port mapping.' }
    }
    $Address = '127.0.0.1'
    if (!$PSBoundParameters.ContainsKey('WifiPort')) { $WifiPort = 52396 }
}

if (!$Address) {
    $net = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.HardwareInterface })
    if ($net.Count -ne 1) { throw 'Specify the IPv4 address of the PC on the lab network with -Address.' }
    $Address = $net[0].IPv4Address[0].IPAddress
}
$state = ".local/quest-wifi"
$cert = "$state/$Address.crt"
$key = "$state/$Address.key"
$origin = "https://${Address}:$WifiPort"
Push-Location $root
try {
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    $openssl = (Get-Command openssl.exe -ErrorAction SilentlyContinue).Source
    if (!$openssl) { $openssl = Join-Path $env:ProgramFiles 'Git/usr/bin/openssl.exe' }
    if (!(Test-Path -LiteralPath $openssl)) { throw 'Install OpenSSL or Git for Windows to create the local HTTPS certificate.' }
    if (!(Test-Path -LiteralPath $cert) -or !(Test-Path -LiteralPath $key)) {
        & $openssl req -new -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$Address" -addext "subjectAltName=IP:$Address" -addext 'basicConstraints=critical,CA:FALSE' -keyout $key -out $cert
        if ($LASTEXITCODE) { throw 'Could not create the local HTTPS certificate.' }
    }
    $listener = Get-NetTCPConnection -State Listen -LocalPort $WifiPort -LocalAddress $Address -ErrorAction SilentlyContinue
    $config = "$state/$Address-$WifiPort.json"
    if ($listener) {
        $old = if (Test-Path -LiteralPath $config) { Get-Content -Raw $config | ConvertFrom-Json }
        if (!$old -or $listener.OwningProcess -ne $old.pid -or $old.auth -ne 'step-capture-8' -or $old.upstream -ne $Port) {
            throw "Port $WifiPort already has a different listener. Stop the previous Wi-Fi gateway before starting this one."
        }
    } else {
        $argsWifi = @('-m','tools.quest_wifi','--address',$Address,'--port',$WifiPort,'--upstream-port',$Port,
            '--cert',$cert,'--key',$key,'--pairing-db',"$state/pairing.sqlite3")
        $service = Start-Process -FilePath (Get-Command python.exe).Source -ArgumentList $argsWifi -WorkingDirectory $root -WindowStyle Hidden -PassThru
        for ($i = 0; $i -lt 12; $i++) {
            $listener = Get-NetTCPConnection -State Listen -LocalPort $WifiPort -LocalAddress $Address -ErrorAction SilentlyContinue
            if ($listener -or $service.HasExited) { break }
            Start-Sleep -Milliseconds 250
        }
        if (!$listener -or $listener.OwningProcess -ne $service.Id) { throw 'The Wi-Fi server did not start.' }
        @{pid=$service.Id; auth='step-capture-8'; upstream=$Port} | ConvertTo-Json | Set-Content $config
    }
    Write-Output "Device URL: $origin/  |  Open ${url} on the host PC to display a QR invitation."
    & $openssl x509 -in $cert -noout -fingerprint -sha256 -enddate
    if ($Usb) {
        & $adb reverse "tcp:$WifiPort" "tcp:$WifiPort"
        if ($LASTEXITCODE) { throw 'Could not forward the paired USB port.' }
        & $adb shell am start -a android.intent.action.VIEW -d "$origin/" -p com.oculus.browser
        if ($LASTEXITCODE) { throw "Open $origin/ in Quest Browser." }
    }
} finally { Pop-Location }
