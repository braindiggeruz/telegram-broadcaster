$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pgBin = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\17\bin' }
$runtimeDir = Join-Path $projectRoot '.runtime'
$dataDir = Join-Path $runtimeDir 'postgres'
if (!(Test-Path -LiteralPath (Join-Path $pgBin 'pg_ctl.exe'))) { throw 'PostgreSQL 17 tools required. Set PG_BIN if installed elsewhere.' }
if (!(Test-Path -LiteralPath (Join-Path $runtimeDir 'postgres-password.txt'))) { throw 'Run node scripts/setup-local.mjs first.' }
if (!(Test-Path -LiteralPath (Join-Path $dataDir 'PG_VERSION'))) {
  $passwordFile = Join-Path $runtimeDir 'postgres-password.txt'
  & (Join-Path $pgBin 'initdb.exe') -D $dataDir -U tgsender -A scram-sha-256 "--pwfile=$passwordFile" --encoding=UTF8 --locale=C
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
}
& (Join-Path $pgBin 'pg_ctl.exe') status -D $dataDir
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $pgBin 'pg_ctl.exe') start -D $dataDir -l (Join-Path $runtimeDir 'postgres.log') -o '-h 127.0.0.1 -p 54329' -w
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL startup failed' }
}
$env:PGPASSWORD = (Get-Content -LiteralPath (Join-Path $runtimeDir 'postgres-password.txt') -Raw).Trim()
try {
  $dbExists = & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p 54329 -U tgsender -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='tgsender'"
  if ($dbExists -ne '1') { & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p 54329 -U tgsender tgsender }
  if ($LASTEXITCODE -ne 0) { throw 'Database creation failed' }
} finally { Remove-Item Env:PGPASSWORD }
