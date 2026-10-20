const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const spawn = require('cross-spawn');
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const { getMakeNsisPath } = builderRequire('app-builder-lib/out/toolsets/windows');

const repository = path.resolve(__dirname, '..');
const powershell = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const helper = path.join(repository, 'build/installer-shortcuts.ps1');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'may-shortcut-host-'));
function run(executable, args, env) {
  const result = spawn.sync(executable, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return result;
}
function ps(script, values = {}) {
  const result = run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], values);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function nsis(value) {
  return value.replaceAll('$', '$$').replaceAll('"', '$\\"');
}

(async () => {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  const target = JSON.parse(ps(`
    $ErrorActionPreference='Stop'
    $programs=$env:ProgramW6432
    $candidate=@('PowerShell\\7\\pwsh.exe','7-Zip\\7z.exe','May Route\\May Route.exe') |
      ForEach-Object { Join-Path $programs $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if(-not $candidate){$candidate=Get-ChildItem -LiteralPath $programs -Filter *.exe -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName}
    if(-not $candidate){throw 'A real Program Files executable is required for the shell-link regression.'}
    @{Executable=$candidate;System=[Security.Principal.WindowsIdentity]::GetCurrent().IsSystem}|ConvertTo-Json
  `));
  const directories = ['user-programs', 'common-programs', 'user-desktop', 'common-desktop'];
  for (const directory of directories) fs.mkdirSync(path.join(root, directory));
  const user = path.join(root, directories[0], 'May Route.lnk');
  const common = path.join(root, directories[1], 'May Route.lnk');
  const desktop = path.join(root, directories[2], 'May Route.lnk');
  function link(destination, executable = target.Executable) {
    ps(`$ErrorActionPreference='Stop';$link=(New-Object -ComObject WScript.Shell).CreateShortcut($env:MAY_SHORTCUT_PATH);$link.TargetPath=$env:MAY_SHORTCUT_TARGET;$link.Save()`, {
      MAY_SHORTCUT_PATH: destination, MAY_SHORTCUT_TARGET: executable,
    });
  }
  const source = fs.readFileSync(path.join(repository, 'build/installer.nsh'), 'utf8');
  const selection = source.match(/!macro selectShortcutPowerShell\r?\n[\s\S]*?!macroend/u)?.[0];
  assert.ok(selection, 'The test must compile the production host selection macro.');
  const compiler = await getMakeNsisPath('1.2.1');
  const hosts = {};
  for (const fixed of [false, true]) {
    const executable = path.join(root, fixed ? 'native-host.exe' : 'redirected-host.exe');
    const script = path.join(root, fixed ? 'native-host.nsi' : 'redirected-host.nsi');
    fs.writeFileSync(script, `Unicode true
!include LogicLib.nsh
!include x64.nsh
Name "May shortcut host regression"
OutFile "${nsis(executable)}"
RequestExecutionLevel user
SilentInstall silent
Var shortcutPowerShell
${selection}
Section
  InitPluginsDir
  File /oname=$PLUGINSDIR\\installer-shortcuts.ps1 "${nsis(helper)}"
  ${fixed ? '!insertmacro selectShortcutPowerShell' : 'StrCpy $shortcutPowerShell "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"'}
  nsExec::ExecToStack '"$shortcutPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\\installer-shortcuts.ps1" -Operation Ensure -ExecutablePath "${nsis(target.Executable)}" -ShortcutName "May Route" -UserPrograms "${nsis(path.join(root, directories[0]))}" -CommonPrograms "${nsis(path.join(root, directories[1]))}" -UserDesktop "${nsis(path.join(root, directories[2]))}" -CommonDesktop "${nsis(path.join(root, directories[3]))}"'
  Pop $1
  Pop $0
  FileOpen $2 "${nsis(path.join(root, fixed ? 'native.log' : 'redirected.log'))}" w
  FileWrite $2 "$0"
  FileClose $2
  SetErrorLevel $1
SectionEnd
`);
    const built = run(compiler.path, ['-V2', '-INPUTCHARSET', 'UTF8', script], compiler.env);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const bytes = fs.readFileSync(executable);
    assert.equal(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4), 0x14c, 'The actual NSIS host must be 32-bit.');
    hosts[fixed ? 'native' : 'redirected'] = executable;
  }
  link(user); link(common); link(desktop);
  const baseline = run(hosts.redirected, []);
  assert.notEqual(baseline.status, 0, 'The previous 32-bit PowerShell host must reproduce the ownership failure.');
  assert.match(fs.readFileSync(path.join(root, 'redirected.log'), 'utf8'), /A different application owns/u);
  assert.ok(fs.existsSync(common), 'The rejected operation must preserve the common entry.');
  const fixed = run(hosts.native, []);
  assert.equal(fixed.status, 0, fs.readFileSync(path.join(root, 'native.log'), 'utf8'));
  assert.ok(fs.existsSync(user) && !fs.existsSync(common), 'The fixed host must reconcile the owned entries.');
  assert.equal(ps(`(New-Object -ComObject WScript.Shell).CreateShortcut($env:MAY_SHORTCUT_PATH).TargetPath`, { MAY_SHORTCUT_PATH: user }), target.Executable);
  assert.ok(fs.existsSync(desktop), 'Shortcut reconciliation must preserve the existing desktop entry.');
  const foreign = path.join(process.env.WINDIR, 'notepad.exe');
  link(user, foreign);
  assert.notEqual(run(hosts.native, []).status, 0, 'The fixed host must continue rejecting foreign ownership.');
  assert.equal(ps(`(New-Object -ComObject WScript.Shell).CreateShortcut($env:MAY_SHORTCUT_PATH).TargetPath`, { MAY_SHORTCUT_PATH: user }), foreign);
  const proof = { checks: 9, system: target.System, nsisHost: 'x86', previousFailure: 'reproduced', nativePowerShell: 'passed', foreignEntryProtection: 'passed' };
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('may-shortcut-host-'));
  fs.rmSync(root, { recursive: true, force: true });
});
