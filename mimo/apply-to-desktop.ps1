$ErrorActionPreference = 'Stop'
$H = Join-Path $env:USERPROFILE '.dsh\profiles'
$dst = Join-Path $H 'desktop\cordis.patch.yml'
$bak = $dst + '.bak-mimo-20260930'
if (-not (Test-Path $bak)) { Copy-Item $dst $bak -Force }
$snip = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'cordis.patch.yml'), [System.Text.UTF8Encoding]::new($false))
$cur = [System.IO.File]::ReadAllText($dst, [System.Text.UTF8Encoding]::new($false))
if ($cur -match '(?m)^\s{2}mimo:\s*$') { Write-Output 'already present, skip' } else {
  $enc = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($dst, $cur.TrimEnd() + [char]10 + $snip, $enc)
  Write-Output 'appended'
}
$now = [System.IO.File]::ReadAllText($dst, [System.Text.UTF8Encoding]::new($false))
Write-Output ('top-level entries: ' + ([regex]::Matches($now, '(?m)^- id:').Count))
Write-Output ('contains mimo: ' + ($now -match 'mimo-v2\.6-pro'))
Write-Output ('backup size: ' + (Get-Item $bak).Length + ' new size: ' + (Get-Item $dst).Length)