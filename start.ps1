# start.ps1 — Start BPMN IQ 2.0 (Server + Client)
$ErrorActionPreference = "Stop"

Write-Host "=== BPMN IQ 2.0 Startup ===" -ForegroundColor Cyan
Write-Host "[OK] Using MongoDB connection on port 27018." -ForegroundColor Green

$env:NODE_OPTIONS = ""
$env:MONGO_URI = "mongodb://127.0.0.1:27018/bpmn_iq"

function Stop-ProcessOnPort {
	param(
		[Parameter(Mandatory = $true)]
		[int] $Port,

		[Parameter(Mandatory = $true)]
		[string] $Name
	)

	$processIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
		Select-Object -ExpandProperty OwningProcess -Unique

	foreach ($processId in @($processIds)) {
		try {
			Stop-Process -Id $processId -Force -ErrorAction Stop
			Write-Host "[OK] Stopped existing $Name process (PID $processId) on port $Port." -ForegroundColor Yellow
		}
		catch {
			Write-Host "[WARN] Could not stop $Name process (PID $processId) on port ${Port}: $($_.Exception.Message)" -ForegroundColor Yellow
		}
	}
}

function Ensure-YarnInstall {
	param(
		[Parameter(Mandatory = $true)]
		[string] $WorkingDirectory
	)

	$nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
	if (-not (Test-Path $nodeModulesPath)) {
		Write-Host "[*] Installing dependencies in $WorkingDirectory..." -ForegroundColor Yellow
		Push-Location $WorkingDirectory
		try {
			& cmd.exe /c yarn.cmd install
		}
		finally {
			Pop-Location
		}
	}
}

function Start-DetachedYarnDev {
	param(
		[Parameter(Mandatory = $true)]
		[string] $WorkingDirectory,

		[Parameter(Mandatory = $true)]
		[string] $Name,

		[Parameter(Mandatory = $true)]
		[string] $ScriptName
	)

	$cmdPath = Join-Path $env:APPDATA 'npm\yarn.cmd'
	if (-not (Test-Path $cmdPath)) {
		throw "Unable to find yarn.cmd at $cmdPath"
	}

	$psi = New-Object System.Diagnostics.ProcessStartInfo
	$psi.FileName = 'cmd.exe'
	$psi.Arguments = "/d /c `"$cmdPath`" run $ScriptName"
	$psi.WorkingDirectory = $WorkingDirectory
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $false
	$psi.RedirectStandardError = $false
	$psi.CreateNoWindow = $true

	$process = New-Object System.Diagnostics.Process
	$process.StartInfo = $psi

	if (-not $process.Start()) {
		throw "Failed to start $Name dev server in $WorkingDirectory"
	}

	Write-Host "[OK] Started $Name dev server in $WorkingDirectory (PID $($process.Id))" -ForegroundColor Green
}

function Start-VisibleYarnDev {
	param(
		[Parameter(Mandatory = $true)]
		[string] $WorkingDirectory,

		[Parameter(Mandatory = $true)]
		[string] $Name,

		[Parameter(Mandatory = $true)]
		[string] $ScriptName
	)

	$cmdPath = Join-Path $env:APPDATA 'npm\yarn.cmd'
	if (-not (Test-Path $cmdPath)) {
		throw "Unable to find yarn.cmd at $cmdPath"
	}

	Write-Host "[*] Launching $Name in a visible console window..." -ForegroundColor Cyan
	Start-Process -FilePath "cmd.exe" -ArgumentList @('/k', "set NODE_OPTIONS=--max-old-space-size=8192 && $cmdPath run $ScriptName") -WorkingDirectory $WorkingDirectory
	Write-Host "[OK] Launched $Name from $WorkingDirectory" -ForegroundColor Green
}

Ensure-YarnInstall -WorkingDirectory $PSScriptRoot
Ensure-YarnInstall -WorkingDirectory (Join-Path $PSScriptRoot "server")
Ensure-YarnInstall -WorkingDirectory (Join-Path $PSScriptRoot "client")

Write-Host "[*] Starting Express server + Vite client..." -ForegroundColor Yellow
Write-Host "    Server: http://localhost:3001" -ForegroundColor Cyan
Write-Host "    Client: http://localhost:5173" -ForegroundColor Cyan

Stop-ProcessOnPort -Port 3001 -Name "Express server"
Stop-ProcessOnPort -Port 5173 -Name "Vite client"

Start-VisibleYarnDev -WorkingDirectory (Join-Path $PSScriptRoot "server") -Name "Express server" -ScriptName "dev"
Start-DetachedYarnDev -WorkingDirectory (Join-Path $PSScriptRoot "client") -Name "Vite client" -ScriptName "dev"

Write-Host "[*] Dev servers launched. The server trace is in its own visible console window." -ForegroundColor Cyan
Write-Host "[*] PowerShell prompt will return immediately." -ForegroundColor Cyan
