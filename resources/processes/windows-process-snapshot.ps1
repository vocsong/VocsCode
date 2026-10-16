# Trusted host resource, never loaded from the workspace. No module/profile or native dependency.
# A long-lived, read-only process table reader for the Processes panel: one Toolhelp snapshot per
# request instead of a WMI query (about 30 ms against 350 ms), so the panel can poll cheaply.
# Protocol, one request per stdin line, every reply terminated by a line holding a single '.':
#   snap            -> pid TAB ppid TAB createdMs TAB cpuMs TAB workingSetBytes TAB exeName
#   cmd <pid> ...   -> pid TAB commandLine   (only for processes this user may query)
# A failed request answers '!' followed by the message, then '.'. Nothing here signals a process.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VocsProcessSnapshot {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESSENTRY32 {
        public uint size; public uint usage; public uint pid; public IntPtr heap; public uint module;
        public uint threads; public uint ppid; public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
    }
    [StructLayout(LayoutKind.Sequential)] struct MEMORY_COUNTERS {
        public uint size; public uint pageFaults; public UIntPtr peakWorkingSet; public UIntPtr workingSet;
        public UIntPtr peakPagedPool; public UIntPtr pagedPool; public UIntPtr peakNonPagedPool; public UIntPtr nonPagedPool;
        public UIntPtr pagefile; public UIntPtr peakPagefile;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr process, out MEMORY_COUNTERS counters, uint size);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr buffer, int length, out int returned);

    const uint TH32CS_SNAPPROCESS = 2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int ProcessCommandLineInformation = 60;
    const long UnixEpochFileTime = 116444736000000000;
    static readonly IntPtr Invalid = new IntPtr(-1);

    static string Clean(string text) {
        return text == null ? "" : text.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
    }

    public static string Snap() {
        var output = new StringBuilder();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == Invalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            var entry = new PROCESSENTRY32();
            entry.size = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32FirstW(snapshot, ref entry)) return "";
            do {
                long createdMs = 0, cpuMs = 0; ulong workingSet = 0;
                IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.pid);
                if (process != IntPtr.Zero) {
                    try {
                        long created, exited, kernel, user;
                        if (GetProcessTimes(process, out created, out exited, out kernel, out user)) {
                            createdMs = created > UnixEpochFileTime ? (created - UnixEpochFileTime) / 10000 : 0;
                            cpuMs = (kernel + user) / 10000;
                        }
                        var counters = new MEMORY_COUNTERS();
                        counters.size = (uint)Marshal.SizeOf(typeof(MEMORY_COUNTERS));
                        if (GetProcessMemoryInfo(process, out counters, counters.size)) workingSet = (ulong)counters.workingSet;
                    } finally { CloseHandle(process); }
                }
                output.Append(entry.pid).Append('\t').Append(entry.ppid).Append('\t').Append(createdMs).Append('\t')
                    .Append(cpuMs).Append('\t').Append(workingSet).Append('\t').Append(Clean(entry.exe)).Append('\n');
            } while (Process32NextW(snapshot, ref entry));
        } finally { CloseHandle(snapshot); }
        return output.ToString();
    }

    public static string CommandLine(uint pid) {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return null;
        try {
            int length;
            NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
            if (length <= 0 || length > 1 << 20) return null;
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try {
                if (NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, length, out length) != 0) return null;
                // UNICODE_STRING { USHORT Length; USHORT MaximumLength; PWSTR Buffer } at the start of the buffer.
                int bytes = (ushort)Marshal.ReadInt16(buffer);
                IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
                if (bytes == 0 || text == IntPtr.Zero) return "";
                return Marshal.PtrToStringUni(text, bytes / 2);
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally { CloseHandle(process); }
    }

    public static string CommandLines(string[] pids) {
        var output = new StringBuilder();
        foreach (var raw in pids) {
            uint pid;
            if (!uint.TryParse(raw, out pid)) continue;
            string line = CommandLine(pid);
            if (line != null) output.Append(pid).Append('\t').Append(Clean(line)).Append('\n');
        }
        return output.ToString();
    }
}
'@
$out = [Console]::Out
$out.Write("ready`n.`n"); $out.Flush()
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $parts = $line.Trim() -split '\s+'
    try {
        if ($parts[0] -eq 'snap') { $out.Write([VocsProcessSnapshot]::Snap()) }
        elseif ($parts[0] -eq 'cmd') { $out.Write([VocsProcessSnapshot]::CommandLines([string[]]($parts | Select-Object -Skip 1))) }
        elseif ($parts[0] -eq 'exit') { break }
        elseif ($parts[0]) { $out.Write("!unknown request`n") }
    } catch {
        $out.Write("!" + ($_.Exception.Message -replace '[\r\n]+', ' ') + "`n")
    }
    $out.Write(".`n"); $out.Flush()
}
