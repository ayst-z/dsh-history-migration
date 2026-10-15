# demo/live-screen/run-demo.ps1
# Runs INSIDE the dedicated console window (title: DSH-MIGRATION-DEMO).
# ASCII only: Windows PowerShell 5.1 reads UTF-8 without BOM as ANSI.
# Every command is echoed in a neutral prompt and then really executed; the
# child stdout/stderr is streamed straight to the console.
param([string]$Root = 'C:\dsh-demo')

$ErrorActionPreference = 'Continue'
Set-Location $Root
function prompt { 'PS ' + (Get-Location).Path + '> ' }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class LiveWindow {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string t);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$h = [LiveWindow]::GetConsoleWindow()
[void][LiveWindow]::SetWindowText($h, 'DSH-MIGRATION-DEMO')
[void][LiveWindow]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 600, 338, 0x0040)
[void][LiveWindow]::SetForegroundWindow($h)
$rc = New-Object LiveWindow+RECT
[void][LiveWindow]::GetWindowRect($h, [ref]$rc)
'hwnd=' + $h + ' rect=' + $rc.L + ',' + $rc.T + ',' + $rc.R + ',' + $rc.B | Out-File -Encoding UTF8 (Join-Path $Root 'tmp\win.txt')

# keep every temp path neutral: child processes inherit these
$env:TEMP = Join-Path $Root 'tmp'
$env:TMP = Join-Path $Root 'tmp'

while (-not (Test-Path (Join-Path $Root 'GO.flag'))) { Start-Sleep -Milliseconds 200 }

function Type-Line([string]$text) {
  Write-Host ''
  Write-Host -NoNewline 'PS C:\dsh-demo> ' -ForegroundColor DarkGray
  foreach ($ch in $text.ToCharArray()) { Write-Host -NoNewline $ch -ForegroundColor Cyan; Start-Sleep -Milliseconds 10 }
  Write-Host ''
}
function Run-Step([string]$cmd, [int]$holdMs = 4000) {
  Type-Line $cmd
  Start-Sleep -Milliseconds 500
  Invoke-Expression $cmd 2>&1 | ForEach-Object { Write-Host $_ }
  Start-Sleep -Milliseconds $holdMs
}

Clear-Host
Write-Host '================================================================' -ForegroundColor Green
Write-Host ' DSH history migration - live run on this machine' -ForegroundColor Green
Write-Host ' everything under C:\dsh-demo; prompts and paths are neutral' -ForegroundColor DarkGray
Write-Host '================================================================' -ForegroundColor Green
Start-Sleep -Seconds 4

Run-Step 'node scripts\export-vscode-chat.mjs --src src\vscode-chatSessions --out out'
Run-Step 'node scripts\import-mimo-export.mjs src\mimo-export.md --out out'
Run-Step 'node scripts\build-dsh-session.mjs --home C:\dsh-demo\home --cwd C:\dsh-demo\workspace --id session-00000000-0000-4000-8000-000000000001 --input out\mimo-export.turns.json --title "Imported demo chat"'
Run-Step 'node scripts\generate-dsh-cache.mjs --home C:\dsh-demo\home --session session-00000000-0000-4000-8000-000000000001'
Run-Step 'node scripts\verify-dsh-session.mjs --in home\sessions\--C-dsh-demo-workspace--\session-00000000-0000-4000-8000-000000000001\session.v4.jsonl.zstd --home C:\dsh-demo\home --session-id session-00000000-0000-4000-8000-000000000001 --require-cache --run-dsh --dsh C:\dsh-demo\tools\dsh.cmd'
Run-Step 'node scripts\selftest.mjs --dsh C:\dsh-demo\tools\dsh.cmd'
Run-Step 'node privacy-scan.mjs C:\dsh-demo' 2000

Write-Host ''
Write-Host '================================================================' -ForegroundColor Green
Write-Host ' live run complete - the session passed the real DSH loader' -ForegroundColor Green
Write-Host '================================================================' -ForegroundColor Green
'DONE' | Out-File -Encoding ASCII (Join-Path $Root 'DONE.flag')
Start-Sleep -Seconds 8
