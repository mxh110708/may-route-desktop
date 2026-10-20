$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'build\installer-data.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer data source did not parse.' }
# Load the real storage functions without relaxing the CLI's fixed ProgramData boundary.
$functions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -in @('Test-DirectoryEmpty', 'Remove-EmptyTransitionStorage')
}, $false))
if ($functions.Count -ne 2) { throw 'Installer storage functions missing.' }
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'build\installer-preflight.ps1') -InstallationDirectory (Split-Path -Parent $PSScriptRoot)
foreach ($name in @('Read-ApplicationDataDirectoryID', 'Assert-ApplicationDataDirectory', 'Resolve-DefaultApplicationDataProfile', 'Get-ApplicationDataCopy')) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false)
    if (-not $function) { throw ('Installer data function missing: ' + $name) }
    Invoke-Expression $function.Extent.Text
}
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$root = Join-Path $temporaryRoot ('may-installer-storage-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
try {
    $empty = Join-Path $root 'empty'
    [void][IO.Directory]::CreateDirectory($empty)
    $StatePath = Join-Path $empty 'data-transition.json'
    Remove-EmptyTransitionStorage
    if (Test-Path -LiteralPath $empty) { throw 'Empty migration storage remains.' }
    Remove-EmptyTransitionStorage
    if (Test-Path -LiteralPath $empty) { throw 'Repeated cleanup recreated migration storage.' }
    $nonempty = Join-Path $root 'nonempty'
    [void][IO.Directory]::CreateDirectory($nonempty)
    $StatePath = Join-Path $nonempty 'data-transition.json'
    $pending = $StatePath + '.old'
    [IO.File]::WriteAllText($pending, 'preserve pending recovery evidence')
    Remove-EmptyTransitionStorage
    if (-not (Test-Path -LiteralPath $pending)) { throw 'Pending migration evidence was removed.' }
    [IO.File]::Delete($pending)
    [void][IO.Directory]::CreateDirectory((Join-Path $nonempty 'recovery'))
    Remove-EmptyTransitionStorage
    if (-not (Test-Path -LiteralPath (Join-Path $nonempty 'recovery'))) { throw 'Recovery subdirectory was removed.' }
    $configured = Join-Path $root 'configured'
    $standard = Join-Path $root 'standard'
    $destination = Join-Path $root 'destination'
    [void][IO.Directory]::CreateDirectory($configured)
    [void][IO.Directory]::CreateDirectory($standard)
    [IO.File]::WriteAllText((Join-Path $configured 'settings.db'), 'configuration fixture')
    $id = [guid]::NewGuid().ToString('B')
    [Box.Installer.DirectoryAccessControl]::WriteDirectoryMarker($configured, $id)
    $profile = [pscustomobject]@{UserID=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;DataPath=$standard}
    function Get-WindowsProfiles { return @{ $profile.UserID = $profile } }
    function Get-ActiveWindowsProfile($Profiles) { return $profile }
    $copy = Get-ApplicationDataCopy $configured $destination $id
    if ($copy.Source -ne $configured -or $copy.Target -ne $destination) { throw 'Changing a configured data directory lost its source.' }
    $copy = Get-ApplicationDataCopy '' $destination $id
    if ($copy.Source -ne $standard -or $copy.Target -ne $destination) { throw 'Moving standard user data lost its source.' }
    $copy = Get-ApplicationDataCopy $configured '' $id
    if ($copy.Target -ne $standard -or $copy.TargetUserID -ne $profile.UserID) { throw 'Returning to standard user data lost the owner.' }
    $rejected = $false
    try { Get-ApplicationDataCopy $configured $destination ([guid]::NewGuid().ToString('B')) | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or [IO.File]::ReadAllText((Join-Path $configured 'settings.db')) -ne 'configuration fixture') { throw 'Foreign data ownership was not preserved.' }
    Write-Output 'Installer storage behavior checks passed: 8'
} finally {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)) -ne $temporaryRoot -or
        (Split-Path -Leaf $root) -notlike 'may-installer-storage-*') { throw 'Invalid storage fixture cleanup root.' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
