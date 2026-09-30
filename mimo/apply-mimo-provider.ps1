$ErrorActionPreference = 'Continue'
$H = Join-Path $env:USERPROFILE '.dsh\profiles'
$snip = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'cordis.patch.yml'), [System.Text.UTF8Encoding]::new($false))
Copy-Item (Join-Path $H 'desktop\cordis.patch.yml') (Join-Path $H 'desktop\cordis.patch.yml.bak-mimo-20260930') -Force
Copy-Item (Join-Path $H 'web\cordis.patch.yml') (Join-Path $H 'web\cordis.patch.yml.bak-mimo-20260930') -Force
$NL = [char]10
$hdr = '# Your patch layer for this dsh profile, applied after every bundle layer:' + $NL + '# a top-level YAML array of loader patch entries (id-targeted config' + $NL + '# overrides, disables, and insert lists; !!js expressions allowed).' + $NL
$enc = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $H 'web\cordis.patch.yml'), $hdr + $snip, $enc)
$cli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$out = Join-Path $env:TEMP 'dsh-web-dump2.txt'
& $cli --profile web --dump-config *> $out
Write-Output ('web dump exit=' + $LASTEXITCODE)
$lines = Get-Content $out
$hit = 0..($lines.Count - 1) | Where-Object { $lines[$_] -match 'mimo' } | Select-Object -First 1
if ($null -ne $hit) { $lines[[Math]::Max(0,$hit-3)..([Math]::Min($lines.Count-1,$hit+12))] } else { Write-Output 'NO MIMO IN DUMP'; $lines | Select-Object -First 15 }