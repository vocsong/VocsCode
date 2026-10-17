# Trusted host resource, never loaded from the workspace. No module/profile or native dependency.
# A long-lived process table reader for the Processes panel: one Toolhelp snapshot per request
# instead of a WMI query (about 30 ms against 350 ms), so the panel can poll cheaply. It also keeps
# one Job Object per owner (a session): a process assigned to it keeps every process it later
# starts in that Job, even one started by a launcher that exits at once (Start-Process from a
# short-lived tool shell), so the owner is known without a living parent chain. The Jobs set no
# limits but allow breakaway: they never kill, throttle or confine anything, and closing them
# (this host exiting) ends nothing.
# Protocol, one request per stdin line, every reply terminated by a line holding a single '.':
#   snap                               -> pid TAB ppid TAB createdMs TAB cpuMs TAB workingSetBytes TAB exeName
#   cmd <pid> ...                      -> pid TAB commandLine   (only for processes this user may query)
#   adopt <owner> <pid>:<createdMs>... -> pid TAB ok | pid TAB !reason   (createdMs 0: not checked)
#   jobs                               -> owner TAB pid pid ...   (live members of each owner's Job)
# A failed request answers '!' followed by the message, then '.'. Nothing here signals a process.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class VocsProcessSnapshot {
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
        public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT basic; public IO_COUNTERS io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    const int JobObjectBasicProcessIdList = 3;
    const int JobObjectExtendedLimitInformation = 9;
    /** Breakaway stays possible, so a program that asks for it (a sandbox, a supervisor) starts as before. */
    const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_SET_QUOTA = 0x0100;
    static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
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

    static IntPtr JobFor(string owner) {
        IntPtr job;
        if (jobs.TryGetValue(owner, out job)) return job;
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var limit = new EXTENDED_LIMIT();
        limit.basic.flags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new System.ComponentModel.Win32Exception(error);
        }
        jobs[owner] = job;
        return job;
    }

    /** Assigns each process to the owner's Job. A creation time other than 0 must match, so a reused PID is never adopted. */
    public static string Adopt(string owner, string[] items) {
        var output = new StringBuilder();
        IntPtr job = JobFor(owner);
        foreach (var item in items) {
            var parts = item.Split(':');
            uint pid;
            long expected = 0;
            if (!uint.TryParse(parts[0], out pid)) continue;
            if (parts.Length > 1) long.TryParse(parts[1], out expected);
            IntPtr process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) { output.Append(pid).Append("\t!open ").Append(Marshal.GetLastWin32Error()).Append('\n'); continue; }
            try {
                long created, exited, kernel, user;
                if (expected != 0 && GetProcessTimes(process, out created, out exited, out kernel, out user) && (created - UnixEpochFileTime) / 10000 != expected) {
                    output.Append(pid).Append("\t!reused\n");
                    continue;
                }
                bool member;
                if (IsProcessInJob(process, job, out member) && member) { output.Append(pid).Append("\tok\n"); continue; }
                if (AssignProcessToJobObject(job, process)) output.Append(pid).Append("\tok\n");
                else output.Append(pid).Append("\t!assign ").Append(Marshal.GetLastWin32Error()).Append('\n');
            } finally { CloseHandle(process); }
        }
        return output.ToString();
    }

    /** The live members of every owner's Job; an owner with none is left out. */
    public static string Members() {
        var output = new StringBuilder();
        int capacity = 1024;
        foreach (var entry in jobs) {
            while (true) {
                int size = 8 + capacity * IntPtr.Size;
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try {
                    bool ok = QueryInformationJobObject(entry.Value, JobObjectBasicProcessIdList, buffer, size, IntPtr.Zero);
                    int assigned = Marshal.ReadInt32(buffer, 0), listed = Marshal.ReadInt32(buffer, 4);
                    if (!ok && assigned > capacity) { capacity = assigned + 64; continue; }
                    if (!ok || listed == 0) break;
                    output.Append(Clean(entry.Key)).Append('\t');
                    for (int i = 0; i < listed; i++) {
                        if (i > 0) output.Append(' ');
                        output.Append((long)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size));
                    }
                    output.Append('\n');
                    break;
                } finally { Marshal.FreeHGlobal(buffer); }
            }
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
        elseif ($parts[0] -eq 'cmd') { $out.Write([VocsProcessSnapshot]::CommandLines([string[]]@($parts | Select-Object -Skip 1))) }
        elseif ($parts[0] -eq 'adopt' -and $parts.Count -ge 2) { $out.Write([VocsProcessSnapshot]::Adopt($parts[1], [string[]]@($parts | Select-Object -Skip 2))) }
        elseif ($parts[0] -eq 'jobs') { $out.Write([VocsProcessSnapshot]::Members()) }
        elseif ($parts[0] -eq 'exit') { break }
        elseif ($parts[0]) { $out.Write("!unknown request`n") }
    } catch {
        $out.Write("!" + ($_.Exception.Message -replace '[\r\n]+', ' ') + "`n")
    }
    $out.Write(".`n"); $out.Flush()
}
