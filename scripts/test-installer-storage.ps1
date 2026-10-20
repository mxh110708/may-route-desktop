$ErrorActionPreference = 'Stop'
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
    Write-Output 'Installer storage behavior checks passed: 4'
} finally {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)) -ne $temporaryRoot -or
        (Split-Path -Leaf $root) -notlike 'may-installer-storage-*') { throw 'Invalid storage fixture cleanup root.' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
