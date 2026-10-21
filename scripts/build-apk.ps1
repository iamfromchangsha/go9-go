# Local Android build: fetch JDK 17 + Android SDK + Gradle, then assemble the debug APK.
# Everything lands under D:\minimax\coder\go9\.build (git-ignored).
$ErrorActionPreference = 'Continue'
$root = 'D:\minimax\coder\go9'
$work = Join-Path $root '.build'
$ProgressPreference = 'SilentlyContinue'

function Fetch($url, $out) {
    if (Test-Path $out) { Write-Host "  [cached] $(Split-Path $out -Leaf)"; return }
    Write-Host "  downloading $(Split-Path $out -Leaf) ..."
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 900
    Write-Host ("  done in {0:N0}s ({1:N1} MB)" -f $sw.Elapsed.TotalSeconds, ((Get-Item $out).Length / 1MB))
}

New-Item -ItemType Directory -Force $work | Out-Null

# ---- 1) JDK 17 ----
$jdkZip = Join-Path $work 'jdk17.zip'
Fetch 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' $jdkZip
if (-not (Test-Path (Join-Path $work 'jdk'))) {
    Write-Host '  extracting JDK ...'
    Expand-Archive -Path $jdkZip -DestinationPath (Join-Path $work 'jdkraw') -Force
    $inner = Get-ChildItem (Join-Path $work 'jdkraw') -Directory | Select-Object -First 1
    Move-Item $inner.FullName (Join-Path $work 'jdk')
}
$env:JAVA_HOME = Join-Path $work 'jdk'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

# ---- 2) Android command line tools ----
$cmdZip = Join-Path $work 'cmdline-tools.zip'
Fetch 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' $cmdZip
$sdk = Join-Path $work 'android-sdk'
if (-not (Test-Path (Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'))) {
    Write-Host '  extracting Android command line tools ...'
    Expand-Archive -Path $cmdZip -DestinationPath (Join-Path $work 'cmdline') -Force
    New-Item -ItemType Directory -Force (Join-Path $sdk 'cmdline-tools') | Out-Null
    Move-Item (Join-Path $work 'cmdline\cmdline-tools') (Join-Path $sdk 'cmdline-tools\latest') -Force
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$sdk\cmdline-tools\latest\bin;$sdk\platform-tools;$env:Path"

# ---- 3) SDK packages ----
Write-Host '  accepting licenses ...'
1..20 | ForEach-Object { & (Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat') --licenses 2>&1 | Out-Null }
Write-Host '  installing platform / build-tools ...'
& (Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat') 'platforms;android-34' 'build-tools;34.0.0' 'platform-tools' 2>&1 | Select-Object -Last 5

# ---- 4) Gradle ----
$gradleZip = Join-Path $work 'gradle.zip'
Fetch 'https://services.gradle.org/distributions/gradle-8.10.2-bin.zip' $gradleZip
if (-not (Test-Path (Join-Path $work 'gradle\bin\gradle.bat'))) {
    Write-Host '  extracting Gradle ...'
    Expand-Archive -Path $gradleZip -DestinationPath (Join-Path $work 'gradraw') -Force
    Move-Item (Join-Path $work 'gradraw\gradle-8.10.2') (Join-Path $work 'gradle')
}
$gradle = Join-Path $work 'gradle\bin\gradle.bat'

# ---- 5) build the APK ----
Write-Host '  building APK ...'
Push-Location (Join-Path $root 'android')
& $gradle assembleDebug --no-daemon --stacktrace 2>&1 | Select-Object -Last 25
Pop-Location

$apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $apk) {
    Write-Host ("`nAPK BUILT: {0} ({1:N1} MB)" -f $apk, ((Get-Item $apk).Length / 1MB))
} else {
    Write-Host "`nAPK BUILD FAILED"
}
