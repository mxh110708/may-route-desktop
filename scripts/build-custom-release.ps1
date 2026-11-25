param(
    [Parameter(Mandatory = $true)]
    [string]$CertificateFile,
    [Parameter(Mandatory = $true)]
    [string]$CertificatePasswordFile,
    [string]$NodeExecutable = "node",
    [string]$GoExecutable = "go",
    [string]$PnpmScript,
    [string]$CargoHome,
    [string]$RustupHome,
    [string]$ElectronDist,
    [string]$Proxy
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Read-ReleaseGit {
    param([string]$Directory, [string[]]$Arguments)
    $value = & git -c "safe.directory=$($Directory.Replace('\', '/'))" -C $Directory @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect release source: $Directory" }
    return $value
}

$coreRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot '..\sing-box'))
$coreSource = Get-Content -LiteralPath (Join-Path $repositoryRoot 'core-source.json') -Raw | ConvertFrom-Json
if ($coreSource.repository -ne 'mxh110708/may-route-core' -or
    $coreSource.commit -notmatch '^[0-9a-f]{40}$' -or
    $coreSource.tag -notmatch '^v[0-9][0-9A-Za-z.-]+$') {
    throw 'The paired May Core source manifest is invalid.'
}
$actualCore = Read-ReleaseGit $coreRoot @('rev-parse', 'HEAD')
$taggedCore = Read-ReleaseGit $coreRoot @('rev-parse', '--verify', "$($coreSource.tag)^{commit}")
if ($actualCore -ne $coreSource.commit -or $taggedCore -ne $coreSource.commit) {
    throw 'The checked-out May Core does not match core-source.json.'
}
foreach ($sourceRoot in @($repositoryRoot, (Join-Path $repositoryRoot 'dashboard'), $coreRoot)) {
    if (Read-ReleaseGit $sourceRoot @('status', '--porcelain')) {
        throw "Release source must be clean: $sourceRoot"
    }
}
$dashboardTree = Read-ReleaseGit $repositoryRoot @('ls-tree', 'HEAD', 'dashboard')
$dashboardSource = ($dashboardTree -split '\s+')[2]
if ((Read-ReleaseGit (Join-Path $repositoryRoot 'dashboard') @('rev-parse', 'HEAD')) -ne $dashboardSource) {
    throw 'Dashboard checkout does not match the recorded gitlink.'
}

if (-not (Test-Path -LiteralPath $CertificateFile -PathType Leaf)) {
    throw "The local code-signing certificate is missing."
}
if (-not (Test-Path -LiteralPath $CertificatePasswordFile -PathType Leaf)) {
    throw "The local code-signing password file is missing."
}
if (-not (Get-Command $NodeExecutable -ErrorAction SilentlyContinue)) {
    throw "The requested Node.js executable is missing."
}
if (-not (Get-Command $GoExecutable -ErrorAction SilentlyContinue)) {
    throw "The requested Go executable is missing."
}

if ($PnpmScript) {
    if (-not (Test-Path -LiteralPath $PnpmScript -PathType Leaf)) {
        throw "The requested pnpm script is missing."
    }
} elseif (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
    throw "pnpm is missing. Pass -PnpmScript or install pnpm."
}
if ($ElectronDist -and -not (Test-Path -LiteralPath $ElectronDist -PathType Leaf)) {
    throw "The requested local Electron distribution is missing."
}

$resolvedNode = (Get-Command $NodeExecutable -ErrorAction Stop).Source
$resolvedGo = (Get-Command $GoExecutable -ErrorAction Stop).Source
$env:PATH = "$(Split-Path -Parent $resolvedNode);$(Split-Path -Parent $resolvedGo);$env:PATH"
$previousPackageManagerSwitch = $env:npm_config_manage_package_manager_versions
$previousHTTPProxy = $env:HTTP_PROXY
$previousHTTPSProxy = $env:HTTPS_PROXY
$previousNoProxy = $env:NO_PROXY
$previousCargoHome = $env:CARGO_HOME
$previousRustupHome = $env:RUSTUP_HOME
$previousElectronDist = $env:SING_BOX_ELECTRON_DIST
$env:npm_config_manage_package_manager_versions = "false"
if ($CargoHome -or $RustupHome) {
    if (-not $CargoHome -or -not $RustupHome) {
        throw "Both CargoHome and RustupHome are required for a portable Rust toolchain."
    }
    $cargoBinaryDirectory = Join-Path $CargoHome "bin"
    if (-not (Test-Path -LiteralPath (Join-Path $cargoBinaryDirectory "cargo.exe") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $cargoBinaryDirectory "rustc.exe") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $cargoBinaryDirectory "rustup.exe") -PathType Leaf)) {
        throw "The requested portable Rust toolchain is incomplete."
    }
    $env:CARGO_HOME = $CargoHome
    $env:RUSTUP_HOME = $RustupHome
    $env:PATH = "$cargoBinaryDirectory;$env:PATH"
}
if ($Proxy) {
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    $env:NO_PROXY = "127.0.0.1,localhost"
}
if ($ElectronDist) {
    $env:SING_BOX_ELECTRON_DIST = (Resolve-Path -LiteralPath $ElectronDist).Path
}
$env:SING_BOX_CUSTOM_CERTIFICATE_FILE = $CertificateFile
$env:SING_BOX_CUSTOM_CERTIFICATE_PASSWORD_FILE = $CertificatePasswordFile

function Invoke-Pnpm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    if ($PnpmScript) {
        & $resolvedNode $PnpmScript @Arguments
    } else {
        & pnpm @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repositoryRoot
try {
    Push-Location (Join-Path $repositoryRoot "..\sing-box")
    try {
        & $resolvedGo test ./experimental/boxdd -run 'TestWorkerMemory|TestWindowsProxy|TestCancelledSystemProxyWrite' -count=1
        if ($LASTEXITCODE -ne 0) { throw "Application worker or Windows system proxy ownership tests failed." }
    } finally {
        Pop-Location
    }
    Invoke-Pnpm test:update-source
    Invoke-Pnpm test:runtime-config
    Invoke-Pnpm test:proxy-ports
    Invoke-Pnpm test:rpc-limits
    Invoke-Pnpm test:public-rules
    Invoke-Pnpm test:system-proxy-recovery
    Invoke-Pnpm test:priority-editor:electron
    Invoke-Pnpm test:custom-isolation
    Invoke-Pnpm test:interface-fonts
    Invoke-Pnpm test:tray-placement
    Invoke-Pnpm test:tray-activation
    Invoke-Pnpm test:tray-menu
    Invoke-Pnpm test:background-idle
    Invoke-Pnpm test:renderer-loading
    Invoke-Pnpm test:localization
    Invoke-Pnpm test:installer-preflight
    Invoke-Pnpm test:installer-shortcuts
    Invoke-Pnpm test:installer-shortcut-host
    Invoke-Pnpm test:installer-storage
    Invoke-Pnpm typecheck
    Invoke-Pnpm -Arguments @("-C", "dashboard", "test", "--", "--run")
    Invoke-Pnpm -Arguments @("-C", "dashboard", "lint")
    Invoke-Pnpm -Arguments @("-C", "dashboard", "lint:css")
    Invoke-Pnpm package:custom:win
} finally {
    Pop-Location
    Remove-Item Env:SING_BOX_CUSTOM_CERTIFICATE_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:SING_BOX_CUSTOM_CERTIFICATE_PASSWORD_FILE -ErrorAction SilentlyContinue
    $env:npm_config_manage_package_manager_versions = $previousPackageManagerSwitch
    $env:HTTP_PROXY = $previousHTTPProxy
    $env:HTTPS_PROXY = $previousHTTPSProxy
    $env:NO_PROXY = $previousNoProxy
    $env:CARGO_HOME = $previousCargoHome
    $env:RUSTUP_HOME = $previousRustupHome
    $env:SING_BOX_ELECTRON_DIST = $previousElectronDist
}
