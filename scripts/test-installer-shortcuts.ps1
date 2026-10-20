$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'build\installer-shortcuts.ps1')
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $temporaryRoot ('may-shortcut-regression-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$shell = New-Object -ComObject WScript.Shell
$assertions = 0
function Assert-Shortcut([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:assertions++
}
function New-TestLink([string]$Path, [string]$Target) {
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $Target
    $link.Save()
}
try {
    $paths = @{}
    foreach ($name in @('user-programs', 'common-programs', 'user-desktop', 'common-desktop', 'app')) {
        $paths[$name] = Join-Path $testRoot $name
        [void][IO.Directory]::CreateDirectory($paths[$name])
    }
    $executable = Join-Path $paths.app 'May Route.exe'
    $foreignExecutable = Join-Path $paths.app 'Other.exe'
    [IO.File]::WriteAllText($executable, 'shortcut fixture; never executed')
    [IO.File]::WriteAllText($foreignExecutable, 'foreign shortcut fixture; never executed')
    $arguments = @{
        Executable = $executable; Name = 'May Route'
        CurrentPrograms = $paths['user-programs']; AllPrograms = $paths['common-programs']
        CurrentDesktop = $paths['user-desktop']; AllDesktop = $paths['common-desktop']
    }
    $user = Join-Path $paths['user-programs'] 'May Route.lnk'
    $common = Join-Path $paths['common-programs'] 'May Route.lnk'
    $userDesktop = Join-Path $paths['user-desktop'] 'May Route.lnk'
    $commonDesktop = Join-Path $paths['common-desktop'] 'May Route.lnk'
    $folders = Get-InstallerUserFolders
    Assert-Shortcut ($folders.Programs -eq [Environment]::GetFolderPath('Programs')) 'Interactive installs must use the current user Programs folder.'
    Assert-Shortcut ($folders.Desktop -eq [Environment]::GetFolderPath('DesktopDirectory')) 'Interactive installs must respect the user desktop location.'
    $folderFile = Join-Path $testRoot 'resolved-folders.ini'
    & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'build\installer-shortcuts.ps1') -Operation Resolve -PathsFile $folderFile
    if ($LASTEXITCODE -ne 0) { throw 'Shortcut folder resolution failed.' }
    $resolved = Get-Content -Raw -LiteralPath $folderFile
    Assert-Shortcut ($resolved.Contains('Programs=' + $folders.Programs) -and $resolved.Contains('Desktop=' + $folders.Desktop)) 'The installer must receive both resolved user paths through its INI file.'
    Sync-InstallerShortcuts -Action Ensure @arguments
    Assert-Shortcut ((Test-Path -LiteralPath $user) -and -not (Test-Path -LiteralPath $common)) 'A fresh install must create only one Start Menu entry.'
    Assert-Shortcut ($shell.CreateShortcut($user).TargetPath -eq $executable) 'The shortcut must target the installed program.'
    New-TestLink $common $executable
    Sync-InstallerShortcuts -Action Ensure @arguments
    Assert-Shortcut ((Test-Path -LiteralPath $user) -and -not (Test-Path -LiteralPath $common)) 'Repair must remove the owned duplicate common entry.'
    New-TestLink $common $foreignExecutable
    Sync-InstallerShortcuts -Action Ensure @arguments
    Assert-Shortcut ($shell.CreateShortcut($common).TargetPath -eq $foreignExecutable) 'Repair must preserve a foreign entry with the same display name.'
    New-TestLink $userDesktop $foreignExecutable
    New-TestLink $commonDesktop $executable
    Sync-InstallerShortcuts -Action Remove @arguments
    Assert-Shortcut (-not (Test-Path -LiteralPath $user)) 'Uninstall must remove the current-user entry.'
    Assert-Shortcut (-not (Test-Path -LiteralPath $commonDesktop)) 'Uninstall must remove the owned desktop entry.'
    Assert-Shortcut ((Test-Path -LiteralPath $common) -and (Test-Path -LiteralPath $userDesktop)) 'Uninstall must preserve foreign Start Menu and desktop entries.'
    New-TestLink $user $foreignExecutable
    New-TestLink $common $executable
    $rejected = $false
    try { Sync-InstallerShortcuts -Action Ensure @arguments } catch { $rejected = $true }
    Assert-Shortcut $rejected 'An occupied current-user entry must stop repair.'
    Assert-Shortcut (($shell.CreateShortcut($user).TargetPath -eq $foreignExecutable) -and (Test-Path -LiteralPath $common)) 'Rejected repair must preserve both entries.'
    $invalidArguments = $arguments.Clone()
    $invalidArguments.Name = '..\Other'
    $rejected = $false
    try { Sync-InstallerShortcuts -Action Ensure @invalidArguments } catch { $rejected = $true }
    Assert-Shortcut $rejected 'Shortcut names must not escape their destination directory.'
    Write-Output ('Installer shortcut behavior checks passed: ' + $assertions)
} finally {
    if (-not [IO.Path]::GetFullPath($testRoot).StartsWith($temporaryRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $testRoot) -notlike 'may-shortcut-regression-*') {
        throw 'Invalid shortcut test cleanup root.'
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
