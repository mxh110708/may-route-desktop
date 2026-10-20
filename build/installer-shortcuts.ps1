param(
    [ValidateSet('Ensure', 'Remove', 'Resolve')][string]$Operation = 'Ensure',
    [string]$PathsFile,
    [string]$ExecutablePath,
    [string]$ShortcutName,
    [string]$UserPrograms,
    [string]$CommonPrograms,
    [string]$UserDesktop,
    [string]$CommonDesktop
)

$ErrorActionPreference = 'Stop'

function Get-InstallerUserFolders {
    if (-not [Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
        return @{
            Programs = [Environment]::GetFolderPath('Programs')
            Desktop = [Environment]::GetFolderPath('DesktopDirectory')
        }
    }
    # Daemon-initiated updates run as SYSTEM in the requesting user's session.
    # Query that session's token, rather than SYSTEM's own profile folders.
    if (-not ('May.InstallerSessionFolders' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
namespace May {
    public static class InstallerSessionFolders {
        [StructLayout(LayoutKind.Sequential)]
        private struct Luid { public uint Low; public int High; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Privileges { public uint Count; public Luid Id; public uint Attributes; }
        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError=true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool LookupPrivilegeValue(string system, string name, out Luid value);
        [DllImport("advapi32.dll", SetLastError=true)]
        private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privileges state, uint length, IntPtr previous, IntPtr returned);
        [DllImport("wtsapi32.dll", SetLastError=true)]
        private static extern bool WTSQueryUserToken(uint session, out IntPtr token);
        [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
        private static extern int SHGetFolderPath(IntPtr window, int folder, IntPtr token, uint flags, StringBuilder path);
        public static string[] Resolve(uint session) {
            IntPtr processToken;
            if (!OpenProcessToken(GetCurrentProcess(), 0x28, out processToken)) throw new Win32Exception();
            try {
                Luid privilege;
                if (!LookupPrivilegeValue(null, "SeTcbPrivilege", out privilege)) throw new Win32Exception();
                var state = new Privileges { Count=1, Id=privilege, Attributes=2 };
                if (!AdjustTokenPrivileges(processToken, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                int error = Marshal.GetLastWin32Error();
                if (error != 0) throw new Win32Exception(error);
            } finally { CloseHandle(processToken); }
            if (session == 0) throw new InvalidOperationException("No interactive installer session.");
            IntPtr userToken;
            if (!WTSQueryUserToken(session, out userToken)) throw new Win32Exception();
            try {
                var result = new string[2];
                int[] folders = { 2, 16 }; // Programs and DesktopDirectory, respecting redirection.
                for (int index=0; index<folders.Length; index++) {
                    var path = new StringBuilder(260);
                    int code = SHGetFolderPath(IntPtr.Zero, folders[index], userToken, 0, path);
                    if (code != 0 || path.Length == 0) throw new InvalidOperationException("Cannot resolve the session user's shell folder: " + code);
                    result[index] = path.ToString();
                }
                return result;
            } finally { CloseHandle(userToken); }
        }
    }
}
'@
    }
    $folders = [May.InstallerSessionFolders]::Resolve([uint32][Diagnostics.Process]::GetCurrentProcess().SessionId)
    return @{ Programs = $folders[0]; Desktop = $folders[1] }
}

function Sync-InstallerShortcuts {
    param(
        [ValidateSet('Ensure', 'Remove')][string]$Action,
        [string]$Executable,
        [string]$Name,
        [string]$CurrentPrograms,
        [string]$AllPrograms,
        [string]$CurrentDesktop,
        [string]$AllDesktop
    )
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name -match '[\\/:*?"<>|]' -or
        -not [IO.Path]::IsPathRooted($Executable)) {
        throw 'Invalid application shortcut identity.'
    }
    $executableFullPath = [IO.Path]::GetFullPath($Executable)
    $shell = New-Object -ComObject WScript.Shell
    $paths = @()
    foreach ($directory in @($CurrentPrograms, $AllPrograms, $CurrentDesktop, $AllDesktop)) {
        if ([string]::IsNullOrWhiteSpace($directory) -or -not [IO.Path]::IsPathRooted($directory)) {
            throw 'Invalid application shortcut directory.'
        }
        $fullDirectory = [IO.Path]::GetFullPath($directory)
        $item = Get-Item -LiteralPath $fullDirectory -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and (-not $item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
            throw 'Application shortcut directories must be normal directories.'
        }
        $paths += Join-Path $fullDirectory ($Name + '.lnk')
    }
    $owned = @{}
    foreach ($path in ($paths | Select-Object -Unique)) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) { continue }
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Unexpected application shortcut entry.'
        }
        $target = $shell.CreateShortcut($path).TargetPath
        $owned[$path] = -not [string]::IsNullOrWhiteSpace($target) -and
            [IO.Path]::GetFullPath($target).Equals($executableFullPath, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($Action -eq 'Ensure') {
        if (-not [IO.File]::Exists($executableFullPath)) { throw 'Application executable missing.' }
        if ($owned.ContainsKey($paths[0]) -and -not $owned[$paths[0]]) {
            throw 'A different application owns the current-user Start Menu entry.'
        }
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $paths[0]))
        $shortcut = $shell.CreateShortcut($paths[0])
        $shortcut.TargetPath = $executableFullPath
        $shortcut.WorkingDirectory = Split-Path -Parent $executableFullPath
        $shortcut.IconLocation = $executableFullPath + ',0'
        $shortcut.Description = $Name
        $shortcut.Save()
        # Electron's toast activator uses the current-user Programs directory.
        # Keep that entry and remove only our own redundant machine-wide entry.
        if ($paths[1] -ne $paths[0] -and $owned[$paths[1]]) {
            Remove-Item -LiteralPath $paths[1] -Force
        }
    } else {
        foreach ($path in ($paths | Select-Object -Unique)) {
            if ($owned[$path]) { Remove-Item -LiteralPath $path -Force }
        }
    }
}

if ($MyInvocation.InvocationName -eq '.') { return }
if ($Operation -eq 'Resolve') {
    if ([string]::IsNullOrWhiteSpace($PathsFile) -or -not [IO.Path]::IsPathRooted($PathsFile)) {
        throw 'Invalid shortcut folder output path.'
    }
    $folders = Get-InstallerUserFolders
    foreach ($path in @($folders.Programs, $folders.Desktop)) {
        if ([string]::IsNullOrWhiteSpace($path) -or -not [IO.Path]::IsPathRooted($path) -or $path -match '[\r\n]') {
            throw 'Invalid session user shortcut folder.'
        }
    }
    [IO.File]::WriteAllText($PathsFile, "[User]`r`nPrograms=$($folders.Programs)`r`nDesktop=$($folders.Desktop)`r`n", [Text.Encoding]::Unicode)
    return
}
Sync-InstallerShortcuts -Action $Operation -Executable $ExecutablePath -Name $ShortcutName `
    -CurrentPrograms $UserPrograms -AllPrograms $CommonPrograms `
    -CurrentDesktop $UserDesktop -AllDesktop $CommonDesktop
