$ProgressPreference = 'SilentlyContinue'
$url = "https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-win64-v2.4.zip"
$zipPath = "scrcpy.zip"
$destPath = "resources\scrcpy"

Write-Host "Creating directory $destPath"
New-Item -ItemType Directory -Force -Path $destPath | Out-Null

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zipPath

Write-Host "Extracting to $destPath"
Expand-Archive -Path $zipPath -DestinationPath "temp_scrcpy" -Force

Write-Host "Moving files..."
Copy-Item -Path "temp_scrcpy\scrcpy-win64-v2.4\*" -Destination $destPath -Recurse -Force

Write-Host "Cleaning up..."
Remove-Item -Path "temp_scrcpy" -Recurse -Force
Remove-Item -Path $zipPath -Force

Write-Host "Done!"
