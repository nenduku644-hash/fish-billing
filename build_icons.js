const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, 'build');
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

console.log('Generating build icons for Windows and macOS...');

if (process.platform === 'win32') {
  const psScript = `
    Add-Type -AssemblyName System.Drawing
    $src = "$PWD\\lord_ganesha.jpg"
    if (Test-Path $src) {
      $img = [System.Drawing.Image]::FromFile($src)
      $bmp512 = New-Object System.Drawing.Bitmap(512, 512)
      $g = [System.Drawing.Graphics]::FromImage($bmp512)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.DrawImage($img, 0, 0, 512, 512)
      $g.Dispose()
      $bmp512.Save("$PWD\\build\\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)

      $bmp256 = New-Object System.Drawing.Bitmap($bmp512, 256, 256)
      $hIcon = $bmp256.GetHicon()
      $icon = [System.Drawing.Icon]::FromHandle($hIcon)
      $fs = [System.IO.File]::OpenWrite("$PWD\\build\\icon.ico")
      $icon.Save($fs)
      $fs.Close()
      $bmp512.Dispose()
      $bmp256.Dispose()
      $img.Dispose()
      Write-Host "Icons generated successfully in build/"
    }
  `;
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, { stdio: 'inherit' });
  } catch (e) {
    console.warn('Icon script notice:', e.message);
  }
}
