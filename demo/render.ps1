# demo/render.ps1 -- rebuild demo.mp4 from scratch.
#
# Pipeline: replay the live demo scripts -> draw one PNG per shot with GDI+ ->
# encode each shot with ffmpeg (fade in/out) -> concat into demo.mp4.
#
# ASCII-only on purpose: it must run on Windows PowerShell 5.1 (ANSI default)
# and on PowerShell 7. All Chinese copy lives in content.json / captured/*.txt,
# which are always read as UTF-8.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File demo/render.ps1 -FfmpegDir <dir with ffmpeg.exe>
#   pwsh -File demo/render.ps1            (ffmpeg/ffprobe taken from PATH)
# Switches: -SkipCapture (reuse captured/*.txt), -SkipVideo (only draw PNGs).

[CmdletBinding()]
param(
  [string]$FfmpegDir = '',
  [string]$DshCli = '',
  [int]$Fps = 30,
  [switch]$SkipCapture,
  [switch]$SkipVideo
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$DemoDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($DemoDir)) { $DemoDir = (Get-Location).Path }
Set-Location $DemoDir

$probeOutFile    = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh_demo_probe_out.txt'
$probeErrFile    = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh_demo_probe_err.txt'
$fallbackOutFile = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh_demo_fallback_out.txt'
$fallbackErrFile = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh_demo_fallback_err.txt'

$FramesDir = Join-Path $DemoDir 'frames'
$ClipsDir  = Join-Path $DemoDir 'clips'
$OutFile   = Join-Path $DemoDir 'demo.mp4'

function Resolve-Exe([string]$Name) {
  if (-not [string]::IsNullOrEmpty($FfmpegDir)) {
    foreach ($cand in @((Join-Path $FfmpegDir ($Name + '.exe')), (Join-Path $FfmpegDir $Name))) {
      if (Test-Path $cand) { return $cand }
    }
  }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "$Name not found; pass -FfmpegDir <directory containing ffmpeg.exe and ffprobe.exe>"
}

$ffmpeg  = Resolve-Exe 'ffmpeg'
$ffprobe = Resolve-Exe 'ffprobe'
Write-Host ("[tool] ffmpeg  " + $ffmpeg)
Write-Host ("[tool] ffprobe " + $ffprobe)

# ---- 1. replay the real pipeline ------------------------------------------------
if (-not $SkipCapture) {
  $dshArg = $DshCli
  if ([string]::IsNullOrEmpty($dshArg)) { $dshArg = $env:DSH_CLI }
  if ([string]::IsNullOrEmpty($dshArg)) { throw 'no DSH launcher: pass -DshCli <dsh.cmd> or set DSH_CLI' }
  # capture runs its own privacy scan over the repo: make sure no stale
  # concat list (which may hold absolute paths) is left from a previous run.
  Get-ChildItem -Path $ClipsDir -Filter 'concat.txt' -ErrorAction SilentlyContinue | Remove-Item -Force
  Write-Host '[capture] running live pipeline ...'
  & node (Join-Path $DemoDir 'live/capture.mjs') --dsh $dshArg
  if ($LASTEXITCODE -ne 0) { throw "capture.mjs failed with exit code $LASTEXITCODE" }
}

# ---- 2. load shot content (UTF-8) ------------------------------------------------
$contentJson = [System.IO.File]::ReadAllText((Join-Path $DemoDir 'content.json'), [System.Text.Encoding]::UTF8)
$content = $contentJson | ConvertFrom-Json
$shots = @($content.shots)
$total = 0.0
foreach ($s in $shots) { $total += [double]$s.duration }
Write-Host ("[plan] shots=" + $shots.Count + " total=" + $total + "s")

# ---- 3. drawing tools ------------------------------------------------------------
$W = 1920
$H = 1080
$C_Bg     = [System.Drawing.Color]::FromArgb(13, 17, 23)
$C_Panel  = [System.Drawing.Color]::FromArgb(1, 4, 9)
$C_Band   = [System.Drawing.Color]::FromArgb(22, 27, 34)
$C_Border = [System.Drawing.Color]::FromArgb(48, 54, 61)
$C_Text   = [System.Drawing.Color]::FromArgb(230, 237, 243)
$C_Muted  = [System.Drawing.Color]::FromArgb(139, 148, 158)
$C_Accent = [System.Drawing.Color]::FromArgb(88, 166, 255)
$C_Green  = [System.Drawing.Color]::FromArgb(63, 185, 80)
$C_Red    = [System.Drawing.Color]::FromArgb(248, 81, 73)
$C_Yellow = [System.Drawing.Color]::FromArgb(210, 153, 34)
$C_MonoOk = [System.Drawing.Color]::FromArgb(126, 231, 135)

$BrBg     = [System.Drawing.SolidBrush]::new($C_Bg)
$BrPanel  = [System.Drawing.SolidBrush]::new($C_Panel)
$BrBand   = [System.Drawing.SolidBrush]::new($C_Band)
$BrText   = [System.Drawing.SolidBrush]::new($C_Text)
$BrMuted  = [System.Drawing.SolidBrush]::new($C_Muted)
$BrAccent = [System.Drawing.SolidBrush]::new($C_Accent)
$BrGreen  = [System.Drawing.SolidBrush]::new($C_Green)
$BrRed    = [System.Drawing.SolidBrush]::new($C_Red)
$BrYellow = [System.Drawing.SolidBrush]::new($C_Yellow)
$BrMonoOk = [System.Drawing.SolidBrush]::new($C_MonoOk)
$PenBorder = [System.Drawing.Pen]::new($C_Border, 2)
$PenAccent = [System.Drawing.Pen]::new($C_Accent, 2)

$FontBig    = [System.Drawing.Font]::new('Microsoft YaHei UI', 74, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$FontTitle  = [System.Drawing.Font]::new('Microsoft YaHei UI', 52, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$FontSub    = [System.Drawing.Font]::new('Microsoft YaHei UI', 30, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$FontKick   = [System.Drawing.Font]::new('Microsoft YaHei UI', 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$FontBullet = [System.Drawing.Font]::new('Microsoft YaHei UI', 34, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$FontNarr   = [System.Drawing.Font]::new('Microsoft YaHei UI', 27, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$FontBox    = [System.Drawing.Font]::new('Microsoft YaHei UI', 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$FontMono   = [System.Drawing.Font]::new('Consolas', 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$FontSmall  = [System.Drawing.Font]::new('Microsoft YaHei UI', 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

function Wrap-Text {
  param($G, [string]$Text, $Font, [int]$MaxWidth)
  $out = New-Object System.Collections.ArrayList
  foreach ($para in ($Text -split ([string][char]10))) {
    $cur = ''
    foreach ($ch in $para.ToCharArray()) {
      $cand = $cur + $ch
      if ($cur.Length -gt 0 -and $G.MeasureString($cand, $Font).Width -gt $MaxWidth) {
        [void]$out.Add($cur)
        $cur = [string]$ch
      } else {
        $cur = $cand
      }
    }
    [void]$out.Add($cur)
  }
  return $out
}

function Draw-Paragraph {
  param($G, [string]$Text, $Font, $Brush, [int]$X, [int]$Y, [int]$MaxWidth, [int]$LineHeight, [string]$Align = 'left')
  $lines = Wrap-Text -G $G -Text $Text -Font $Font -MaxWidth $MaxWidth
  $yy = $Y
  foreach ($ln in $lines) {
    if ($Align -eq 'center') {
      $lw = $G.MeasureString($ln, $Font).Width
      $G.DrawString($ln, $Font, $Brush, [single]($X + ($MaxWidth - $lw) / 2), [single]$yy)
    } else {
      $G.DrawString($ln, $Font, $Brush, [single]$X, [single]$yy)
    }
    $yy += $LineHeight
  }
  return $yy
}

function Draw-Chrome {
  param($G, $Shot, [int]$Index, [int]$Total)
  $G.Clear($C_Bg)
  $G.FillRectangle($BrAccent, 0, 0, $W, 6)
  $G.DrawString([string]$Shot.kicker, $FontKick, $BrAccent, [single]120, [single]54)
  $counter = ('{0:d2} / {1:d2}' -f ($Index + 1), $Total)
  $cw = $G.MeasureString($counter, $FontSmall).Width
  $G.DrawString($counter, $FontSmall, $BrMuted, [single]($W - 120 - $cw), [single]60)
  $G.FillRectangle($BrBand, 0, 930, $W, 150)
  $G.FillRectangle($BrAccent, 0, 930, $W, 3)
  Draw-Paragraph -G $G -Text ([string]$Shot.narration) -Font $FontNarr -Brush $BrText -X 120 -Y 958 -MaxWidth 1560 -LineHeight 36 | Out-Null
  $wm = 'dsh-history-migration'
  $ww = $G.MeasureString($wm, $FontSmall).Width
  $G.DrawString($wm, $FontSmall, $BrMuted, [single]($W - 120 - $ww), [single]1044)
}

function Draw-Title {
  param($G, $Shot)
  $G.FillRectangle($BrAccent, 120, 152, 8, 54)
  $G.DrawString([string]$Shot.title, $FontTitle, $BrText, [single]152, [single]146)
  return 250
}

function Draw-Cover {
  param($G, $Shot)
  $y = Draw-Paragraph -G $G -Text ([string]$Shot.title) -Font $FontBig -Brush $BrText -X 120 -Y 286 -MaxWidth 1680 -LineHeight 102 -Align 'center'
  $y = Draw-Paragraph -G $G -Text ([string]$Shot.subtitle) -Font $FontSub -Brush $BrMuted -X 120 -Y ($y + 24) -MaxWidth 1680 -LineHeight 46 -Align 'center'
  $badge = [string]$Shot.badge
  $bw = $G.MeasureString($badge, $FontSmall).Width + 56
  $bx = ($W - $bw) / 2
  $G.FillRectangle($BrPanel, [single]$bx, [single]($y + 36), [single]$bw, 58)
  $G.DrawRectangle($PenAccent, [single]$bx, [single]($y + 36), [single]$bw, 58)
  $G.DrawString($badge, $FontSmall, $BrAccent, [single]($bx + 28), [single]($y + 53))
}

function Draw-List {
  param($G, $Shot)
  $y = Draw-Title -G $G -Shot $Shot
  foreach ($b in @($Shot.bullets)) {
    $G.FillRectangle($BrAccent, 120, $y + 12, 6, 30)
    $end = Draw-Paragraph -G $G -Text ([string]$b) -Font $FontBullet -Brush $BrText -X 170 -Y $y -MaxWidth 1590 -LineHeight 48
    $y = [Math]::Max($y + 88, $end + 28)
  }
}

function Draw-Flow {
  param($G, $Shot)
  $y = Draw-Title -G $G -Shot $Shot
  $steps = @($Shot.steps)
  $n = $steps.Count
  $gap = 34
  $boxW = [int]((1680 - $gap * ($n - 1)) / $n)
  $boxH = 230
  $by = 400
  for ($i = 0; $i -lt $n; $i++) {
    $x = 120 + $i * ($boxW + $gap)
    $G.FillRectangle($BrPanel, $x, $by, $boxW, $boxH)
    $G.DrawRectangle($PenBorder, $x, $by, $boxW, $boxH)
    $G.FillRectangle($BrAccent, $x, $by, $boxW, 4)
    $G.DrawString(('{0:d2}' -f ($i + 1)), $FontSmall, $BrAccent, [single]($x + 18), [single]($by + 22))
    Draw-Paragraph -G $G -Text ([string]$steps[$i]) -Font $FontBox -Brush $BrText -X ($x + 16) -Y ($by + 92) -MaxWidth ($boxW - 32) -LineHeight 40 -Align 'center' | Out-Null
    if ($i -lt $n - 1) {
      $G.DrawString('>', $FontTitle, $BrAccent, [single]($x + $boxW + 4), [single]($by + 88))
    }
  }
}

function Draw-Code {
  param($G, $Shot)
  $y = Draw-Title -G $G -Shot $Shot
  $px = 120
  $py = $y + 16
  $pw = 1680
  $ph = 412
  $G.FillRectangle($BrPanel, $px, $py, $pw, $ph)
  $G.DrawRectangle($PenBorder, $px, $py, $pw, $ph)
  $G.FillRectangle($BrAccent, $px, $py, $pw, 3)
  $ly = $py + 30
  $first = $true
  foreach ($ln in @($Shot.lines)) {
    if ($first) { $brush = $BrMonoOk } else { $brush = $BrText }
    $end = Draw-Paragraph -G $G -Text ([string]$ln) -Font $FontMono -Brush $brush -X ($px + 30) -Y $ly -MaxWidth ($pw - 60) -LineHeight 40
    $ly = $end + 18
    $first = $false
  }
  Draw-Paragraph -G $G -Text ([string]$Shot.note) -Font $FontSub -Brush $BrMuted -X 120 -Y ($py + $ph + 40) -MaxWidth 1680 -LineHeight 44 | Out-Null
}

function Draw-Terminal {
  param($G, $Shot)
  $y = Draw-Title -G $G -Shot $Shot
  $G.DrawString('PS>', $FontMono, $BrMuted, [single]122, [single]($y + 6))
  $cw = $G.MeasureString('PS> ', $FontMono).Width
  $G.DrawString([string]$Shot.command, $FontMono, $BrAccent, [single](122 + $cw), [single]($y + 6))

  $px = 120
  $pw = 1680
  $text = ''
  foreach ($f in @($Shot.captures)) {
    $p = Join-Path $DemoDir ('captured/' + $f)
    if (Test-Path $p) { $text += [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
    else { $text += '[missing capture] ' + $f + [char]10 }
  }
  $raw = $text -split ([string][char]10)
  $lines = @()
  foreach ($l in $raw) {
    $t = $l.TrimEnd([char]13)
    if ($t -ne '') { $lines += $t }
  }
  $maxLines = 15
  $shown = $lines
  if ($lines.Count -gt $maxLines) {
    $head = 5
    $tail = $maxLines - $head - 1
    $shown = @()
    for ($i = 0; $i -lt $head; $i++) { $shown += $lines[$i] }
    $shown += ('... ' + $lines.Count + ' lines total ...')
    for ($i = $lines.Count - $tail; $i -lt $lines.Count; $i++) { $shown += $lines[$i] }
  }
  $py = $y + 58
  $ph = 74 + ($shown.Count * 32)
  if ($ph -lt 240) { $ph = 240 }
  if ($ph -gt 620) { $ph = 620 }
  $G.FillRectangle($BrPanel, $px, $py, $pw, $ph)
  $G.DrawRectangle($PenBorder, $px, $py, $pw, $ph)
  $G.FillRectangle($BrBand, $px + 2, $py + 2, $pw - 4, 38)
  $G.FillEllipse($BrRed, $px + 20, $py + 15, 12, 12)
  $G.FillEllipse($BrYellow, $px + 42, $py + 15, 12, 12)
  $G.FillEllipse($BrGreen, $px + 64, $py + 15, 12, 12)
  $G.DrawString('captured stdout (real run)', $FontSmall, $BrMuted, [single]($px + 96), [single]($py + 10))
  $ly = $py + 58
  foreach ($ln in $shown) {
    if ($ln -match 'FAIL') { $brush = $BrRed }
    elseif ($ln -match 'PASS') { $brush = $BrMonoOk }
    else { $brush = $BrText }
    $end = Draw-Paragraph -G $G -Text $ln -Font $FontMono -Brush $brush -X ($px + 30) -Y $ly -MaxWidth ($pw - 60) -LineHeight 32
    $ly = $end + 2
  }
}

# ---- 4. render one PNG per shot --------------------------------------------------
if (-not (Test-Path $FramesDir)) { New-Item -ItemType Directory -Path $FramesDir | Out-Null }
if (-not (Test-Path $ClipsDir)) { New-Item -ItemType Directory -Path $ClipsDir | Out-Null }
Get-ChildItem -Path $FramesDir -Filter '*.png' -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem -Path $ClipsDir -Filter '*.mp4' -ErrorAction SilentlyContinue | Remove-Item -Force

$idx = 0
foreach ($shot in $shots) {
  $png = Join-Path $FramesDir ($shot.id + '.png')
  $bmp = [System.Drawing.Bitmap]::new($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  Draw-Chrome -G $g -Shot $shot -Index $idx -Total $shots.Count
  switch ([string]$shot.kind) {
    'cover'    { Draw-Cover -G $g -Shot $shot }
    'flow'     { Draw-Flow -G $g -Shot $shot }
    'code'     { Draw-Code -G $g -Shot $shot }
    'terminal' { Draw-Terminal -G $g -Shot $shot }
    default    { Draw-List -G $g -Shot $shot }
  }
  $g.Dispose()
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("[frame] " + $shot.id + ".png  " + $shot.duration + "s")
  $idx++
}

if ($SkipVideo) { Write-Host '[done] PNG only (-SkipVideo)'; exit 0 }

# ---- 5. encode clips + concat ----------------------------------------------------
$fade = 0.4
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$listLines = @()
foreach ($shot in $shots) {
  $png = Join-Path $FramesDir ($shot.id + '.png')
  $clip = Join-Path $ClipsDir ($shot.id + '.mp4')
  $dur = [double]$shot.duration
  $fo = $dur - $fade
  $vf = 'fade=t=in:st=0:d=' + $fade.ToString('0.00', $inv) + ',fade=t=out:st=' + $fo.ToString('0.00', $inv) + ':d=' + $fade.ToString('0.00', $inv) + ',format=yuv420p'
  & $ffmpeg -y -loglevel error -loop 1 -framerate $Fps -t $dur -i $png -vf $vf -r $Fps -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p $clip
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed for $($shot.id)" }
  # relative file name only: keeps concat.txt free of any absolute user path
  $listLines += ("file '" + $shot.id + ".mp4'")
  Write-Host ("[clip] " + $shot.id + ".mp4  " + $dur + "s")
}
$listPath = Join-Path $ClipsDir 'concat.txt'
[System.IO.File]::WriteAllLines($listPath, $listLines, (New-Object System.Text.UTF8Encoding($false)))
& $ffmpeg -y -loglevel error -f concat -safe 0 -i $listPath -c copy -movflags +faststart $OutFile
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg concat failed' }

Write-Host '[probe] ------------------------------------------------------------'
# ffprobe is the primary reporter. Some locked-down hosts block ffprobe.exe via
# Application Control while still allowing ffmpeg.exe, so fall back to ffmpeg -i.
# Start-Process is used so the tool's stderr never becomes a PowerShell error record.
$probeOk = $false
try {
  $p = Start-Process -FilePath $ffprobe -ArgumentList @('-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,r_frame_rate,pix_fmt','-show_entries','format=duration,size','-of','default=noprint_wrappers=1',('"' + $OutFile + '"')) -RedirectStandardOutput $probeOutFile -RedirectStandardError $probeErrFile -NoNewWindow -Wait -PassThru
  if ($p.ExitCode -eq 0) {
    $probeOk = $true
    Get-Content -Path $probeOutFile | ForEach-Object { Write-Host $_ }
  }
} catch { $probeOk = $false }
if (-not $probeOk) {
  Write-Host '[probe] ffprobe.exe unavailable (blocked by host policy); falling back to: ffmpeg -i'
  Start-Process -FilePath $ffmpeg -ArgumentList @('-hide_banner','-i',('"' + $OutFile + '"')) -RedirectStandardOutput $fallbackOutFile -RedirectStandardError $fallbackErrFile -NoNewWindow -Wait | Out-Null
  foreach ($l in @(Get-Content -Path $fallbackErrFile)) {
    if ($l -match 'Duration:|Stream #0:0') { Write-Host $l }
  }
}
Write-Host ("[done] " + $OutFile)
