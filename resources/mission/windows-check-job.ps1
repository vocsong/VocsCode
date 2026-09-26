# Trusted host resource, never loaded from the workspace. No module/profile or native dependency.
# The shell is born suspended, assigned to a non-breakaway Job Object, then resumed. Only the
# three explicit stdio handles are inherited: check output cannot forge supervisor receipts.
param([string]$ControlPipe = '', [string]$OwnerIntent = '', [string]$OwnerHash = '', [string]$GuardianPipe = '', [long]$GuardianJob = 0, [long]$GuardianParent = 0)
$ErrorActionPreference = 'Stop'
if (!$GuardianPipe) {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class MissionCheckJob {
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
        public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved; public string desktop; public string title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
        public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT basic; public IO_COUNTERS io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long userTime, kernelTime, periodUser, periodKernel;
        public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSa, IntPtr threadSa, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFileEx(string source, string target, uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    delegate bool ControlHandler(uint kind);
    static readonly ControlHandler ignoreConsoleInterrupt = kind => kind == 0 || kind == 1;
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(ControlHandler handler, bool add);

    static readonly object outputLock = new object();
    static int canceled, resumeRequested;
    static TextWriter receipts;
    static string receiptPath, receiptIdentity, guardianExecutable, guardianHelper, guardianIntent, guardianHash;
    public static void EnableGuardian(string executable, string helper, string intent, string hash) {
        guardianExecutable = executable; guardianHelper = helper; guardianIntent = intent; guardianHash = hash;
    }
    public static void ConfigureGuardianReceipt(string path, string identity) {
        if (File.ReadAllText(path + ".claimed") != identity) throw new Exception("Guardian ownership claim mismatch");
        using (var claim = new FileStream(path + ".guardian", FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            byte[] bytes = Encoding.UTF8.GetBytes(identity); claim.Write(bytes, 0, bytes.Length); claim.Flush(true);
        }
        receiptPath = path; receiptIdentity = identity;
    }
    public static void ConfigureOwnershipReceipt(string path, string identity) {
        if (File.Exists(path)) throw new Exception("Ownership intent already has a terminal receipt");
        // Single-use intent: a second supervisor must never run under an already-receipted nonce,
        // including two racing launches. The durable claim is retained after crashes, not recycled.
        using (var claim = new FileStream(path + ".claimed", FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            byte[] bytes = Encoding.UTF8.GetBytes(identity); claim.Write(bytes, 0, bytes.Length); claim.Flush(true);
        }
        receiptPath = path; receiptIdentity = identity;
    }
    static void WriteOwnershipReceipt(string outcome) {
        if (receiptPath == null) return;
        string json = receiptIdentity.Substring(0, receiptIdentity.Length - 1) + ",\"source\":\"supervisor\",\"outcome\":\"" + outcome + "\",\"quiescent\":true,\"childTreeZero\":true,\"completedAt\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}";
        string temporary = receiptPath + ".tmp-" + Guid.NewGuid().ToString();
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
            file.Write(bytes, 0, bytes.Length); file.Flush(true);
        }
        Check(MoveFileEx(temporary, receiptPath, 8)); // Atomic same-volume rename, WRITE_THROUGH; no replacement.
    }
    // Only used when connecting/reading the launch request failed before Run could create a target.
    public static void RecordNotStarted() { WriteOwnershipReceipt("not_started"); }
    static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero; }
    static string Flag(bool value) { return value ? "true" : "false"; }
    static string Enc(string text) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(text)); }
    static void Emit(string json) {
        lock (outputLock) {
            try { receipts.WriteLine(json); receipts.Flush(); }
            catch { Interlocked.Exchange(ref canceled, 1); }
        }
        // Pipe loss requests cancellation; it must not escape the scoped teardown/retry loop or
        // prevent the durable empty-Job receipt that the next desktop process needs for recovery.
    }
    static void Inherit(int kind, out IntPtr handle) {
        Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out handle, 0, true, 2));
    }
    static uint Active(IntPtr job) {
        ACCOUNTING accounting;
        Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
        return accounting.activeProcesses;
    }
    static Task Pump(IntPtr handle, string kind) {
        return Task.Factory.StartNew(() => {
            using (var stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false)) {
                var bytes = new byte[4096]; int size;
                while ((size = stream.Read(bytes, 0, bytes.Length)) != 0)
                    Emit("{\"type\":\"" + kind + "\",\"data\":\"" + Convert.ToBase64String(bytes, 0, size) + "\"}");
            }
        }, TaskCreationOptions.LongRunning);
    }
    // A termination API's success is not quiescence. Query the owned kernel object until empty.
    static bool Stop(IntPtr job, IntPtr process, bool assigned) {
        if (assigned) {
            if (Active(job) == 0) return true;
            Check(TerminateJobObject(job, 1));
            var until = Stopwatch.StartNew();
            while (Active(job) != 0 && until.ElapsedMilliseconds < 10000) Thread.Sleep(20);
            return Active(job) == 0;
        }
        if (process == IntPtr.Zero) return true;
        if (WaitForSingleObject(process, 0) == 0) return true;
        Check(TerminateProcess(process, 1)); // Still suspended: it has never run or spawned children.
        return WaitForSingleObject(process, 10000) == 0;
    }

    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    // This process lives outside ConPTY and libuv's kill-on-parent-close Job. Only the two exact
    // kernel handles are inherited. A reused PID or a newly empty manager can prove nothing.
    static NamedPipeServerStream StartGuardian(IntPtr job) {
        string name = "vocs-owner-" + Guid.NewGuid().ToString();
        var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        IntPtr ownJob = IntPtr.Zero, ownParent = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero;
        bool initialized = false;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        try {
            Check(DuplicateHandle(GetCurrentProcess(), job, GetCurrentProcess(), out ownJob, 0, true, 2));
            Check(DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), out ownParent, 0, true, 2));
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 2); Marshal.WriteIntPtr(handles, 0, ownJob); Marshal.WriteIntPtr(handles, IntPtr.Size, ownParent);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero));
            var startup = new STARTUPINFOEX(); startup.info.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.attributes = attributes;
            string command = Quote(guardianExecutable) + " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(guardianHelper)
                + " -OwnerIntent " + Quote(guardianIntent) + " -OwnerHash " + guardianHash + " -GuardianPipe " + name + " -GuardianJob " + ownJob.ToInt64() + " -GuardianParent " + ownParent.ToInt64();
            Check(CreateProcess(guardianExecutable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
                0x01000000 | 0x08000000 | 0x00080000, IntPtr.Zero, null, ref startup, out child)); // BREAKAWAY_FROM_JOB | NO_WINDOW | EXTENDED_STARTUPINFO
            if (!pipe.WaitForConnectionAsync().Wait(15000)) throw new Exception("Ownership guardian did not connect");
            return pipe;
        } catch { pipe.Dispose(); throw; }
        finally {
            Close(ref child.thread); Close(ref child.process); Close(ref ownJob); Close(ref ownParent);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }
    public static void Guard(long jobValue, long parentValue, string name) {
        IntPtr job = new IntPtr(jobValue), parent = new IntPtr(parentValue);
        NamedPipeClientStream pipe = null; TextWriter writer = null;
        bool handedOff = false;
        try {
            Active(job); // Validate the inherited kernel handle before admitting a target.
            pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous); pipe.Connect(10000);
            writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
            var reader = new StreamReader(pipe, new UTF8Encoding(false));
            writer.WriteLine("ready");
            handedOff = reader.ReadLine() == "finish";
        } catch { }
        // A disconnected pipe alone is NOT a no-more-spawns proof. Wait for the exact original
        // supervisor handle, unless it explicitly committed to never spawning again.
        if (!handedOff) Check(WaitForSingleObject(parent, 0xffffffff) == 0);
        bool quiet = false;
        while (!quiet) { try { quiet = Stop(job, IntPtr.Zero, true); } catch { } if (!quiet) Thread.Sleep(100); }
        try {
            WriteOwnershipReceipt("job_empty");
            try { if (writer != null) writer.WriteLine("done"); } catch { }
        } finally { if (pipe != null) pipe.Dispose(); Close(ref job); Close(ref parent); }
    }

    // Raw commandLine is a trusted host-built Win32 command line, not a shell-escaped argv list.
    public static void Run(string executable, string commandLine, string cwd, int timeoutMs, bool inheritStdio, TextReader control, TextWriter outputReceipts, bool waitForResume) {
        receipts = outputReceipts;
        IntPtr job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
        IntPtr errRead = IntPtr.Zero, errWrite = IntPtr.Zero, input = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero;
        bool attributesReady = false, assigned = false, quiet = false, timedOut = false, lingering = false, consoleAttached = false;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        Task output = null, error = null;
        NamedPipeServerStream guardian = null; StreamReader guardianReader = null; StreamWriter guardianWriter = null;
        string failure = null; uint exit = 1;
        // EOF is also cancellation: a crashed desktop cannot leave an unattended live Job.
        Task.Factory.StartNew(() => {
            while (true) {
                string line;
                try { line = control.ReadLine(); } catch { line = null; }
                if (line == null || line == "cancel") { Interlocked.Exchange(ref canceled, 1); if (line == null) return; }
                if (line == "resume") Interlocked.Exchange(ref resumeRequested, 1);
            }
        }, TaskCreationOptions.LongRunning);
        try {
            if (inheritStdio) {
                consoleAttached = SetConsoleCtrlHandler(ignoreConsoleInterrupt, true);
                // Detached RPC supervisors deliberately have pipes but no console. ConPTY still
                // installs this handler; lack of a console is not a failed ownership boundary.
                if (!consoleAttached && Marshal.GetLastWin32Error() != 6) Check(false);
            }
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limits = new EXTENDED_LIMIT();
            limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; neither BREAKAWAY nor SILENT_BREAKAWAY.
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
            if (guardianExecutable != null) {
                guardian = StartGuardian(job);
                guardianReader = new StreamReader(guardian, new UTF8Encoding(false));
                guardianWriter = new StreamWriter(guardian, new UTF8Encoding(false)) { AutoFlush = true };
                var ready = guardianReader.ReadLineAsync();
                if (!ready.Wait(15000) || ready.Result != "ready") throw new Exception("Ownership guardian did not attest its handles");
            }
            if (inheritStdio) {
                // A terminal launches this supervisor inside ConPTY. Inherit that console and
                // exactly its three std handles; never inherit the separate control-pipe handle.
                Inherit(-10, out input); Inherit(-11, out outWrite); Inherit(-12, out errWrite);
            } else {
                var sa = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = true };
                Check(CreatePipe(out outRead, out outWrite, ref sa, 0));
                Check(CreatePipe(out errRead, out errWrite, ref sa, 0));
                Check(SetHandleInformation(outRead, 1, 0)); Check(SetHandleInformation(errRead, 1, 0));
                input = CreateFile("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
                Check(input != new IntPtr(-1));
            }
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); attributesReady = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, outWrite); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errWrite);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            var startup = new STARTUPINFOEX();
            startup.info.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.info.flags = 0x100;
            startup.info.stdin = input; startup.info.stdout = outWrite; startup.info.stderr = errWrite; startup.attributes = attributes;
            uint flags = 0x00000004 | 0x00080000; // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT
            if (!inheritStdio || !consoleAttached) flags |= 0x08000000; // Captured checks / detached RPC: no new target console.
            Check(CreateProcess(executable, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, ref startup, out process));
            Check(AssignProcessToJobObject(job, process.process)); assigned = true;
            Close(ref outWrite); Close(ref errWrite); Close(ref input);
            if (!inheritStdio) {
                output = Pump(outRead, "stdout"); outRead = IntPtr.Zero;
                error = Pump(errRead, "stderr"); errRead = IntPtr.Zero;
            }
            Emit("{\"type\":\"ready\",\"processId\":" + process.pid + "}");
            // A verification host releases its listening-port reservation at this barrier. The
            // terminal mode defaults to immediate resume and keeps raw stdin out of this protocol.
            while (waitForResume && Volatile.Read(ref resumeRequested) == 0 && Volatile.Read(ref canceled) == 0) Thread.Sleep(10);
            if (Volatile.Read(ref canceled) == 0) Check(ResumeThread(process.thread) != 0xffffffff);
            var elapsed = Stopwatch.StartNew();
            while (true) {
                uint wait = WaitForSingleObject(process.process, 20);
                if (wait == 0) {
                    Check(GetExitCodeProcess(process.process, out exit));
                    // A signaled root may precede the Job accounting decrement by a few ticks.
                    // Keep ownership during this bounded drain, then terminate any remaining child.
                    var drain = Stopwatch.StartNew();
                    while (Active(job) != 0 && drain.ElapsedMilliseconds < 250) Thread.Sleep(10);
                    lingering = Active(job) != 0;
                    quiet = lingering ? Stop(job, process.process, assigned) : true;
                    break;
                }
                Check(wait == 258);
                timedOut = timeoutMs > 0 && elapsed.ElapsedMilliseconds >= timeoutMs;
                if (timedOut || Volatile.Read(ref canceled) != 0) {
                    quiet = Stop(job, process.process, assigned);
                    if (quiet) Check(GetExitCodeProcess(process.process, out exit));
                    break;
                }
            }
            if (!quiet) throw new Exception("Owned Job did not become empty after termination");
        } catch (Exception ex) {
            failure = ex.Message;
            try { quiet = Stop(job, process.process, assigned); } catch (Exception stopError) { failure += "; teardown: " + stopError.Message; }
        } finally {
            Close(ref outWrite); Close(ref errWrite); Close(ref input);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            Close(ref outRead); Close(ref errRead);
        }
        // Retain the exact kernel handles when ownership is uncertain; retry scoped teardown.
        // The desktop keeps its lease too. It never substitutes taskkill/PID enumeration.
        if (!quiet) {
            Emit("{\"type\":\"uncertain\",\"error64\":\"" + Enc(failure ?? "Job teardown could not be confirmed") + "\"}");
            while (!quiet) {
                Thread.Sleep(500);
                try { quiet = Stop(job, process.process, assigned); } catch { }
            }
        }
        try {
            if (output != null) output.Wait();
            if (error != null) error.Wait();
        } catch (Exception ex) { failure = "Output capture failed: " + ex.Message; }
        // Commit no-more-spawns before handing final publication to the independently held Job.
        if (guardianWriter != null) {
            guardianWriter.WriteLine("finish");
            var done = guardianReader.ReadLineAsync();
            if (!done.Wait(15000) || done.Result != "done") throw new Exception("Ownership guardian did not publish its receipt");
            guardian.Dispose();
        } else WriteOwnershipReceipt("job_empty");
        Close(ref process.thread); Close(ref process.process); Close(ref job);
        Emit("{\"type\":\"done\",\"quiescent\":true,\"childTreeZero\":true,\"code\":" + exit + ",\"timedOut\":" + Flag(timedOut) + ",\"canceled\":" + Flag(Volatile.Read(ref canceled) != 0) + ",\"lingering\":" + Flag(lingering) + ",\"error64\":\"" + Enc(failure ?? "") + "\"}");
    }
}
'@
if ($OwnerIntent -or $OwnerHash) {
    # The immutable identity is supplied before pipe connection so even pre-connect host death
    # can receive a not-started proof. Never put the target argv/environment in this record.
    if (![IO.Path]::IsPathRooted($OwnerIntent) -or $OwnerHash -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid durable ownership parameters' }
    $info = Get-Item -LiteralPath $OwnerIntent
    if ($info.Length -gt 16384 -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid ownership intent file' }
    $bytes = [IO.File]::ReadAllBytes($OwnerIntent)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($actualHash -cne $OwnerHash) { throw 'Ownership intent hash mismatch' }
    $owner = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    if ($owner.schemaVersion -ne 1 -or $owner.nonce -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $owner.createdAt -lt 0 -or [IO.Path]::GetFileName($OwnerIntent) -cne "$($owner.nonce).intent.json") { throw 'Invalid ownership intent identity' }
    $fields = (($owner.PSObject.Properties.Name | Sort-Object) -join ',')
    $identity = [ordered]@{ schemaVersion = 1; kind = $owner.kind; nonce = $owner.nonce; intentHash = $OwnerHash }
    if ($owner.kind -ceq 'mission-pi') {
        if (!$ControlPipe -or $fields -cne 'createdAt,generation,kind,missionId,nonce,schemaVersion,sessionId' -or $owner.sessionId -cnotmatch '^[A-Za-z0-9_-]+$' -or $owner.missionId -cnotmatch '^[A-Za-z0-9_-]+$' -or $owner.generation -lt 0) { throw 'Invalid Pi ownership identity' }
        $identity.sessionId = $owner.sessionId; $identity.missionId = $owner.missionId; $identity.generation = $owner.generation
    } elseif ($owner.kind -ceq 'mission-check') {
        if ($ControlPipe -or $fields -cne 'createdAt,kind,missionId,nonce,operationId,schemaVersion' -or $owner.missionId -cnotmatch '^[A-Za-z0-9_-]+$' -or $owner.operationId -cnotmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid check ownership identity' }
        $identity.missionId = $owner.missionId; $identity.operationId = $owner.operationId
    } elseif ($owner.kind -ceq 'terminal') {
        if ((!$ControlPipe -and !$GuardianPipe) -or $fields -cne 'createdAt,cwd,kind,nonce,schemaVersion,sessionId,terminalId' -or $owner.sessionId -cnotmatch '^[A-Za-z0-9_-]+$' -or $owner.terminalId -cnotmatch '^[A-Za-z0-9_-]+$' -or ![IO.Path]::IsPathRooted($owner.cwd)) { throw 'Invalid terminal ownership identity' }
        $identity.sessionId = $owner.sessionId; $identity.terminalId = $owner.terminalId; $identity.cwd = $owner.cwd
    } else { throw 'Unsupported process ownership kind' }
    $identity = $identity | ConvertTo-Json -Compress
    $receipt = [IO.Path]::Combine([IO.Path]::GetDirectoryName($OwnerIntent), "$($owner.nonce).receipt.json")
    if ($GuardianPipe) {
        if ($owner.kind -cne 'terminal' -or !$GuardianJob -or !$GuardianParent -or $ControlPipe) { throw 'Invalid guardian ownership' }
        [MissionCheckJob]::ConfigureGuardianReceipt($receipt, $identity)
    } else {
        [MissionCheckJob]::ConfigureOwnershipReceipt($receipt, $identity)
        if ($owner.kind -ceq 'terminal') { [MissionCheckJob]::EnableGuardian((Join-Path $PSHOME 'powershell.exe'), $PSCommandPath, $OwnerIntent, $OwnerHash) }
    }
}
if ($GuardianPipe) {
    [MissionCheckJob]::Guard($GuardianJob, $GuardianParent, $GuardianPipe)
} elseif ($ControlPipe) {
    # PTYs and RPC pipes share this mode. Raw stdio never carries control or receipts.
    $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $ControlPipe, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    $runStarted = $false
    try {
        $pipe.Connect(10000)
        $reader = New-Object IO.StreamReader($pipe, (New-Object Text.UTF8Encoding($false)))
        $writer = New-Object IO.StreamWriter($pipe, (New-Object Text.UTF8Encoding($false)))
        $writer.AutoFlush = $true
        $request = $reader.ReadLine() | ConvertFrom-Json
        if ($request.inheritStdio -ne $true -or ![IO.Path]::IsPathRooted($request.executable)) { throw 'Invalid inherited-stdio launch request' }
        $runStarted = $true
        [MissionCheckJob]::Run([string]$request.executable, [string]$request.commandLine, [string]$request.cwd, [int]$request.timeoutMs, $true, $reader, $writer, [bool]$request.waitForResume)
    } catch {
        if (!$runStarted) { [MissionCheckJob]::RecordNotStarted() }
        throw
    } finally { $pipe.Dispose() }
} else {
    $runStarted = $false
    try {
        $request = [Console]::In.ReadLine() | ConvertFrom-Json
        if (!$request -or ![IO.Path]::IsPathRooted($request.shell)) { throw 'Invalid captured check launch request' }
        $commandLine = '"' + [string]$request.shell + '" /d /s /c "' + [string]$request.command + '"'
        $runStarted = $true
        [MissionCheckJob]::Run([string]$request.shell, $commandLine, [string]$request.cwd, [int]$request.timeoutMs, $false, [Console]::In, [Console]::Out, [bool]$request.waitForResume)
    } catch {
        if (!$runStarted) { [MissionCheckJob]::RecordNotStarted() }
        throw
    }
}
