$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/.modules.yaml'))) {
  & pnpm install --frozen-lockfile
  if($LASTEXITCODE -ne 0){throw 'Dependency installation failed'}
}
& node scripts/setup-local.mjs
if($LASTEXITCODE -ne 0){throw 'Setup failed'}
& ./scripts/local-postgres.ps1
if($LASTEXITCODE -ne 0){throw 'Database startup failed'}
& pnpm db:migrate
if($LASTEXITCODE -ne 0){throw 'Migrations failed'}
& pnpm build
if($LASTEXITCODE -ne 0){throw 'Build failed'}
$check=Test-NetConnection -ComputerName 127.0.0.1 -Port 3037 -InformationLevel Quiet -WarningAction SilentlyContinue
if($check){Write-Output 'Port 3037 is already listening; existing process preserved.';exit 0}
$process=Start-Process -FilePath 'node.exe' -ArgumentList @('scripts/run.mjs','production') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot '.runtime/app.log') -RedirectStandardError (Join-Path $projectRoot '.runtime/app-error.log') -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $projectRoot '.runtime/supervisor.pid')
$ready=$false
for($attempt=0; $attempt -lt 45; $attempt++) {
  try {
    $health=Invoke-RestMethod -Uri 'http://127.0.0.1:3037/readyz' -TimeoutSec 2
    if($health.ready -eq $true){$ready=$true;break}
  } catch {}
  if($process.HasExited){break}
  Start-Sleep -Seconds 2
}
if(!$ready){throw 'TG Sender is not ready. Inspect .runtime/app.log and .runtime/app-error.log.'}
Write-Output 'TG Sender started: http://127.0.0.1:3037. Owner password: .runtime/owner-password.txt (private local file).'
