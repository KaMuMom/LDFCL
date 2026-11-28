param(
    [Parameter(Mandatory)]
    [ValidatePattern('^beta(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string]$ReleaseTag,

    [string]$RustTarget = 'x86_64-pc-windows-msvc',
    [string]$RustToolchain = '1.100.1',

    [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "LDFCL packaging $([guid]::NewGuid())"
$target = Join-Path $repo "target/$RustTarget/release"
$outputDir = Join-Path $repo 'dist'
$setupName = "LDFCL-$ReleaseTag-Windows-x64-Setup"
$setup = Join-Path $outputDir "$setupName.exe"

function Set-PackagingPhase([string]$Name, [string[]]$Logs = @()) {
    $script:phase = $Name
    $script:phaseLogs = $Logs
    Write-Host "[packaging] $Name"
}

function Get-VerifiedDownload($Uri, $Path, $SHA256) {
    Invoke-WebRequest $Uri -OutFile $Path -TimeoutSec 120
    if ((Get-FileHash -Algorithm SHA256 $Path).Hash -ne $SHA256) {
        throw "SHA-256 mismatch for $Uri"
    }
    Unblock-File -LiteralPath $Path
}

function Invoke-BoundedProcess($File, [string[]]$Arguments, [int]$TimeoutSeconds, $OutputLog, $ErrorLog) {
    $startOptions = @{ FilePath = $File; ArgumentList = $Arguments; PassThru = $true }
    if ($OutputLog) { $startOptions.RedirectStandardOutput = $OutputLog }
    if ($ErrorLog) { $startOptions.RedirectStandardError = $ErrorLog }
    $process = Start-Process @startOptions
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill($true) } catch { Write-Warning 'Could not stop the timed-out process tree' }
        throw "$(Split-Path -Leaf $File) exceeded its ${TimeoutSeconds}s timeout"
    }
    if ($process.ExitCode -ne 0) {
        throw "$(Split-Path -Leaf $File) exited with code $($process.ExitCode)"
    }
}

function Invoke-Installer($File, [string[]]$Arguments, $Log) {
    Invoke-BoundedProcess $File ($Arguments + ('/LOG="{0}"' -f $Log)) 150
}

function Test-InstallerLanguage($Log, $Locale) {
    if (-not (Select-String -Path $Log -Pattern "LDFCL installer language: $Locale" -SimpleMatch -Quiet)) {
        throw "The installer did not select locale $Locale"
    }
}

function Copy-DependencyLicenses($Destination) {
    $metadata = Join-Path $scratch 'cargo-metadata.json'
    $metadataErrors = Join-Path $scratch 'cargo-metadata.log'
    Set-PackagingPhase 'Collect dependency licenses' @($metadataErrors)
    Invoke-BoundedProcess 'cargo.exe' @("+$RustToolchain", 'metadata', '--locked', '--format-version', '1', '--filter-platform', $RustTarget) `
        180 $metadata $metadataErrors
    $manifest = Get-Content -LiteralPath $metadata -Encoding utf8 -Raw | ConvertFrom-Json
    $summary = foreach ($crate in $manifest.packages | Sort-Object name,version) {
        if ($crate.id -in $manifest.workspace_members) { continue }
        $crateRoot = Split-Path -Parent $crate.manifest_path
        $notices = @(Get-ChildItem -LiteralPath $crateRoot -File | Where-Object {
            $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE|UNLICENSE)([-_.].*)?$'
        })
        if ($crate.license_file) {
            $notices += Get-Item -LiteralPath (Join-Path $crateRoot $crate.license_file)
        }
        if ($notices.Count) {
            $crateDest = Join-Path $Destination "$($crate.name)-$($crate.version)"
            New-Item $crateDest -ItemType Directory -Force | Out-Null
            $notices | Sort-Object FullName -Unique | Copy-Item -Destination $crateDest
        }
        "$($crate.name) $($crate.version) $($crate.license) $($crate.repository)"
    }
    Set-Content (Join-Path $Destination 'dependencies.txt') -Encoding utf8 $summary
}

Push-Location $repo
try {
    Set-PackagingPhase 'Stage compiled Windows binaries'
    $package = Join-Path $scratch 'package'
    $runtimeBin = Join-Path $package 'runtime/bin'
    $licenses = Join-Path $package 'runtime/licenses'
    New-Item $runtimeBin, $licenses, $outputDir -ItemType Directory -Force | Out-Null
    Copy-Item (Join-Path $target 'LDFCL.exe'), (Join-Path $target 'ldfcl-uninstall.exe'), 'LICENSE' $package
    Copy-Item (Join-Path $target 'ldfcl-cli.exe') $runtimeBin
    Copy-DependencyLicenses $licenses

    Set-PackagingPhase 'Download Inno Setup and Simplified Chinese messages'
    $compilerInstaller = Join-Path $scratch 'innosetup-6.7.4.exe'
    $compilerDirectory = Join-Path $scratch 'Inno Setup 6.7.4'
    $chineseMessages = Join-Path $scratch 'ChineseSimplified.isl'
    Get-VerifiedDownload 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_4/innosetup-6.7.4.exe' `
        $compilerInstaller 'a549929319f9120716677c685535ca4671e4b937b5fdc87e2585f32d8eb30e8c'
    Get-VerifiedDownload 'https://raw.githubusercontent.com/jrsoftware/issrc/c2913c993858a781fcb455bac8b8949c1c366cb8/Files/Languages/Unofficial/ChineseSimplified.isl' `
        $chineseMessages '7d544b9bb1d142cfa11f2e5d3cc8abe2e55f8e066c5124e3772675aa236e1278'
    $silent = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    $silentSetup = $silent + '/SP-'
    $innoLog = Join-Path $scratch 'inno.log'
    Set-PackagingPhase 'Install Inno Setup compiler' @($innoLog)
    Invoke-Installer $compilerInstaller ($silentSetup + ('/DIR="{0}"' -f $compilerDirectory)) $innoLog
    $iscc = Join-Path $compilerDirectory 'ISCC.exe'
    $compilerLog = Join-Path $scratch 'iscc.log'
    $compilerErrors = Join-Path $scratch 'iscc-errors.log'
    Set-PackagingPhase 'Compile the bilingual installer' @($compilerLog, $compilerErrors)
    $compilerArgs = @(
        "/DReleaseTag=$ReleaseTag",
        ('"/DSourceRoot={0}"' -f $package),
        "/DSetupBasename=$setupName",
        ('"/DOutputRoot={0}"' -f $outputDir),
        ('"/DChineseMessages={0}"' -f $chineseMessages),
        ('"{0}"' -f (Join-Path $PSScriptRoot 'LDFCL.iss'))
    )
    Invoke-BoundedProcess $iscc $compilerArgs 240 $compilerLog $compilerErrors

    $hash = (Get-FileHash -Algorithm SHA256 $setup).Hash.ToLowerInvariant()
    Set-Content -Encoding ascii "$setup.sha256" "$hash  $setupName.exe"
    if (-not $SmokeTest) { return }

    $appRoot = Join-Path $scratch 'LDFCL Install Test'
    $previous = Join-Path $scratch 'PCL 测试'
    $gameRoot = Join-Path $previous '.minecraft'
    $fixtureVersion = Join-Path $gameRoot 'versions/fixture'
    New-Item $fixtureVersion -ItemType Directory -Force | Out-Null
    Set-Content (Join-Path $fixtureVersion 'fixture.json') -Encoding ascii '{"mainClass":"fixture.Main","libraries":[],"javaVersion":{"majorVersion":17}}'
    Set-Content (Join-Path $fixtureVersion 'fixture.jar') -Encoding ascii 'Fixture client'
    $registry = 'HKCU:\Software\LDFCL\LDFCL'
    $setupArgs = $silentSetup + ('/DIR="{0}"' -f $appRoot)
    $legacySetup = Join-Path $scratch 'LDFCL-beta1.0.2-Windows-x64-Setup.exe'
    Set-PackagingPhase 'Download the published beta1.0.2 installer'
    Get-VerifiedDownload 'https://github.com/KaMuMom/LDFCL/releases/download/beta1.0.2/LDFCL-beta1.0.2-Windows-x64-Setup.exe' `
        $legacySetup 'b66c9afc8870523b4ac79da306100df84e90ea2d8f9051860ac5af4433aead7a'
    $legacyLog = Join-Path $scratch 'legacy.log'
    Set-PackagingPhase 'Install beta1.0.2 with an imported game directory' @($legacyLog)
    Invoke-Installer $legacySetup ($setupArgs + '/LANG=en' + ('/GAMEFOLDER="{0}"' -f $previous)) $legacyLog
    if (-not (Test-Path (Join-Path $appRoot 'runtime/bin/Qt6Core.dll'))) { throw 'The legacy Qt layout is missing' }

    $manualJava = 'runtime/bin/manual-java/java.exe'
    $installedJava = Join-Path $appRoot $manualJava
    New-Item (Split-Path -Parent $installedJava), (Join-Path $appRoot 'config') -ItemType Directory -Force | Out-Null
    Copy-Item (Join-Path $env:SystemRoot 'System32/cmd.exe') $installedJava
    @(
        '[General]',
        'automaticJava=false',
        'gameLayout=2',
        "javaExecutable=$manualJava",
        "addedJavaPaths=$manualJava"
    ) | Set-Content (Join-Path $appRoot 'config/settings.ini') -Encoding utf8

    $chineseLog = Join-Path $scratch 'zhcn.log'
    Set-PackagingPhase 'Upgrade beta1.0.2 with the Simplified Chinese installer' @($chineseLog)
    Invoke-Installer $setup ($setupArgs + '/LANG=zhcn') $chineseLog
    Test-InstallerLanguage $chineseLog 'zhcn'
    $gamePreference = 'config/game-directory.txt'
    $selectedGame = (Get-Content (Join-Path $appRoot $gamePreference) -Encoding utf8 -Raw).Trim()
    if ($selectedGame -ne $gameRoot) { throw 'The upgrade changed the imported Minecraft directory' }
    $rootItems = (Get-ChildItem $appRoot -Force | Sort-Object Name).Name -join ','
    if ($rootItems -ne 'config,LDFCL.exe,runtime,Uninstall.exe') { throw "Unexpected install root contents: $rootItems" }
    if (Test-Path (Join-Path $appRoot 'runtime/bin/Qt6Core.dll')) { throw 'The upgrade left the obsolete Qt runtime' }
    if (-not (Test-Path $installedJava)) { throw 'The upgrade removed a user-installed Java executable' }
    if ((Get-Content (Join-Path $appRoot 'runtime/LICENSE.zh-CN.txt') -Encoding utf8 -Raw) -notmatch 'MIT 许可证') {
        throw 'The Simplified Chinese license notice was not installed'
    }
    $cliOutput = Join-Path $scratch 'cli.txt'
    $cliErrors = Join-Path $scratch 'cli.log'
    Set-PackagingPhase 'Check the installed CLI can find the imported game' @($cliErrors)
    Invoke-BoundedProcess (Join-Path $appRoot 'runtime/bin/ldfcl-cli.exe') @('list', '--game-dir', ('"{0}"' -f $previous)) 30 $cliOutput $cliErrors
    $versions = (Get-Content -LiteralPath $cliOutput -Raw).Trim()
    if ($versions -ne 'fixture') { throw 'The installed CLI could not list the imported version' }

    $moved = Join-Path $scratch 'LDFCL Moved Test'
    $guiErrors = Join-Path $scratch 'gui.log'
    Set-PackagingPhase 'Open GPUI from a moved directory and verify migrated settings' @($guiErrors)
    Move-Item $appRoot $moved
    $env:GPUI_DISABLE_DIRECT_COMPOSITION = '1'
    $gui = Start-Process (Join-Path $moved 'LDFCL.exe') -PassThru -RedirectStandardError $guiErrors
    try {
        $migratedConfig = Join-Path $moved 'config/settings.json'
        $deadline = [datetime]::UtcNow.AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 250
            $gui.Refresh()
            if ($gui.HasExited) { throw "The GPUI launcher exited with code $($gui.ExitCode)" }
        } until (($gui.MainWindowHandle -ne [IntPtr]::Zero -and (Test-Path $migratedConfig)) -or [datetime]::UtcNow -ge $deadline)
        if ($gui.MainWindowHandle -eq [IntPtr]::Zero) { throw 'The GPUI launcher did not open its window' }
        if (-not (Test-Path $migratedConfig)) { throw 'The GPUI launcher did not migrate settings in its moved directory' }
        if (-not (Test-Path (Join-Path $moved 'cache'))) { throw 'The GPUI cache directory was not created under the installation' }
        $settings = Get-Content $migratedConfig -Encoding utf8 -Raw | ConvertFrom-Json
        if ($settings.automatic_java -ne $false -or $settings.layout -ne 'isolated' -or
            ($settings.java_executable -replace '\\', '/') -ne $manualJava -or
            ($settings.added_java_paths[0] -replace '\\', '/') -ne $manualJava) {
            throw 'Migrated settings changed the isolation mode, automatic Java preference or relative Java path'
        }
    } finally {
        if (-not $gui.HasExited) {
            $gui.Kill($true)
            if (-not $gui.WaitForExit(10000)) { throw 'The GPUI launcher did not exit after termination' }
        }
        Move-Item $moved $appRoot
    }

    $uninstallLog = Join-Path $scratch 'uninstall.log'
    Set-PackagingPhase 'Uninstall and verify user data remains' @($uninstallLog)
    Invoke-Installer (Join-Path $appRoot 'Uninstall.exe') $silent $uninstallLog
    $deadline = [datetime]::UtcNow.AddSeconds(60)
    while ((Test-Path (Join-Path $appRoot 'LDFCL.exe')) -and [datetime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (Test-Path (Join-Path $appRoot 'LDFCL.exe')) { throw 'Uninstall did not finish within 60s' }
    foreach ($required in @($installedJava, (Join-Path $fixtureVersion 'fixture.jar'),
            (Join-Path $appRoot $gamePreference), (Join-Path $appRoot 'config/settings.json'))) {
        if (-not (Test-Path $required)) { throw "Uninstall removed user data: $required" }
    }

    Remove-ItemProperty $registry -Name gameDirectory
    $freshRoot = Join-Path $scratch 'LDFCL English Install Test'
    $englishLog = Join-Path $scratch 'en.log'
    Set-PackagingPhase 'Verify a fresh installation in English' @($englishLog)
    Invoke-Installer $setup ($silentSetup + ('/DIR="{0}"' -f $freshRoot) + '/LANG=en') $englishLog
    Test-InstallerLanguage $englishLog 'en'
    $fresh = (Get-Content (Join-Path $freshRoot $gamePreference) -Encoding utf8 -Raw).Trim()
    $expected = (Join-Path $env:LOCALAPPDATA 'LDFCL/game').Replace('/', '\')
    if ($fresh -ne $expected -or -not (Test-Path (Join-Path $fresh 'versions'))) { throw "Wrong fresh game directory: $fresh" }
    Write-Host "Verified installer: $setup"
} catch {
    $details = @($_.Exception.Message)
    foreach ($log in $phaseLogs) {
        if (Test-Path -LiteralPath $log -PathType Leaf) {
            try { $details += Get-Content -LiteralPath $log -Tail 16 } catch { }
        }
    }
    $message = ($details -join "`n") -replace '(https?://[^?\s]+)\?\S+', '$1?[redacted]'
    if ($message.Length -gt 7000) { $message = $message.Substring(0, 7000) }
    $message = $message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Host "::error title=${phase}::$message"
    throw
} finally {
    Pop-Location
}
