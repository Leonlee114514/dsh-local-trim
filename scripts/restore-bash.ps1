# 恢复 desktop profile 里被 pnpm 剪掉的 @dsh-ops/bash-win32-x64（dsh-ops 的 ops_bash 依赖它）
# 用法: powershell -ExecutionPolicy Bypass -File restore-bash.ps1
$ErrorActionPreference = 'Stop'
$ver = '0.2.1'
$dest = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@dsh-ops\bash-win32-x64'
$bin = Join-Path $dest 'bin\bash.exe'

if (Test-Path $bin) { Write-Output "already present: $bin"; exit 0 }

$tmp = Join-Path $env:TEMP 'dsh-bash-restore'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Push-Location $tmp
try {
  npm pack "@dsh-ops/bash-win32-x64@$ver" 2>&1 | Out-Null
  $tgz = Get-ChildItem $tmp -Filter '*.tgz' | Select-Object -First 1
  if (-not $tgz) { throw 'npm pack failed' }
  tar -xzf $tgz.FullName -C $tmp
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item (Join-Path $tmp 'package') $dest
} finally { Pop-Location }

if (Test-Path $bin) { Write-Output "restored: $bin"; & $bin -c 'echo bash-ok' } else { throw "restore failed: $bin" }
