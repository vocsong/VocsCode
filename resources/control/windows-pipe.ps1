# Trusted bundled script for Windows PowerShell 5.1 -NoProfile -NonInteractive.
# Serve's redirected stdin is also the desktop's lifetime pipe. Keep it open until shutdown.
# The helper transports opaque bytes; the desktop owns JSON validation, profile and grant checks.
param(
    [string]$Mode,
    [string]$PipeName,
    [string]$ParentPid,
    [string]$ExpectedPid,
    [string]$ExpectedStarted
)

$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0 -or $PSVersionTable.PSEdition -ne 'Desktop' -or
    $PSVersionTable.PSVersion -lt [version]'5.1') { exit 4 }

try {
    Add-Type -WarningAction SilentlyContinue -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class VocsLocalWindowsPipe {
    private const int Mismatch = 3, Unavailable = 4;
    private const int RequestLimit = 8192, ReplyLimit = 262144;
    private const int PollMs = 50, CancelMs = 1000, InputMs = 5000, OutputMs = 2000;
    private const int ConnectMs = 2500, RequestMs = 3000, ParentReplyMs = 8000;
    private const int ReplyWriteMs = 4000, PeerCloseMs = 1500, CallExchangeMs = 14000;
    private const uint Duplex = 3, FirstInstance = 0x00080000, Overlapped = 0x40000000;
    private const uint RejectRemoteClients = 8; // Otherwise byte type, byte read mode, blocking mode.
    private const uint ProcessQueryLimitedInformation = 0x1000, Synchronize = 0x00100000, TokenQuery = 8;
    private const uint WaitObject0 = 0, WaitTimeout = 258;
    private const int StdInput = -10, StdOutput = -11;
    private const int BrokenPipe = 109, NoData = 232, PipeNotConnected = 233;
    private const string Base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes {
        public int Length;
        public IntPtr Descriptor;
        public int InheritHandle;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr ptr);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipeW(string path, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DisconnectNamedPipe(SafePipeHandle pipe);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CancelIoEx(SafePipeHandle pipe, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint id);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long born, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size, IntPtr read, out uint available, IntPtr left);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr handle, [Out] byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(IntPtr handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);

    // Bridge faults are not peer I/O faults; they must never resume the serving loop.
    private sealed class BridgeFailure : Exception { }
    private sealed class DesktopClosed : Exception { }
    private sealed class Deadline {
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly int milliseconds;
        public Deadline(int milliseconds) { this.milliseconds = milliseconds; }
        public int NextWait() {
            long remaining = milliseconds - clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new TimeoutException();
            return (int)Math.Min(remaining, PollMs);
        }
    }

    private static SafeProcessHandle Open(uint pid) {
        return OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, pid);
    }

    private static bool Live(SafeProcessHandle process) {
        if (process.IsInvalid) throw new BridgeFailure();
        uint status = WaitForSingleObject(process, 0);
        if (status == WaitTimeout) return true;
        if (status == WaitObject0) return false;
        throw new BridgeFailure();
    }

    private static long Birth(SafeProcessHandle process) {
        long born, exited, kernel, user;
        if (process.IsInvalid || !GetProcessTimes(process, out born, out exited, out kernel, out user) || born <= 0)
            throw new BridgeFailure();
        return born;
    }

    private static SecurityIdentifier User(SafeProcessHandle process) {
        SafeAccessTokenHandle token;
        if (process.IsInvalid || !OpenProcessToken(process, TokenQuery, out token)) throw new BridgeFailure();
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle())) {
            if (identity.User == null) throw new BridgeFailure();
            return identity.User;
        }
    }

    private static IntPtr StandardHandle(int kind) {
        var handle = GetStdHandle(kind);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new BridgeFailure();
        return handle;
    }

    private static void Wait(Task task, Deadline deadline, Action check) {
        while (true) {
            if (check != null) check();
            int wait = deadline == null ? PollMs : deadline.NextWait();
            if (task.IsCompleted) {
                task.GetAwaiter().GetResult();
                return;
            }
            ((IAsyncResult)task).AsyncWaitHandle.WaitOne(wait);
        }
    }

    private static void WaitPipe(Task task, SafePipeHandle handle, Deadline deadline, Action check) {
        try { Wait(task, deadline, check); }
        catch {
            // .NET Framework's pipe cancellation tokens do not cancel in-flight overlapped I/O.
            // Never disconnect/reuse the instance until the old operation has completed.
            if (!task.IsCompleted) {
                CancelIoEx(handle, IntPtr.Zero);
                if (!((IAsyncResult)task).AsyncWaitHandle.WaitOne(CancelMs)) throw new BridgeFailure();
            }
            if (task.IsFaulted) GC.KeepAlive(task.Exception);
            throw;
        }
    }

    private static void ReadExact(PipeStream pipe, SafePipeHandle handle, byte[] buffer, Deadline deadline, Action check) {
        for (int offset = 0; offset < buffer.Length;) {
            var task = pipe.ReadAsync(buffer, offset, buffer.Length - offset);
            WaitPipe(task, handle, deadline, check);
            if (task.Result == 0) throw new IOException();
            offset += task.Result;
        }
    }

    private static byte[] ReadFrame(PipeStream pipe, SafePipeHandle handle, int limit, Deadline deadline, Action check) {
        var header = new byte[4];
        ReadExact(pipe, handle, header, deadline, check);
        uint length = (uint)header[0] | ((uint)header[1] << 8) | ((uint)header[2] << 16) | ((uint)header[3] << 24);
        if (length == 0 || length > limit) throw new IOException();
        var body = new byte[(int)length];
        ReadExact(pipe, handle, body, deadline, check);
        return body;
    }

    private static void WriteFrame(PipeStream pipe, SafePipeHandle handle, byte[] body, Deadline deadline, Action check) {
        int length = body.Length;
        byte[] header = { (byte)length, (byte)(length >> 8), (byte)(length >> 16), (byte)(length >> 24) };
        if (check != null) check();
        WaitPipe(pipe.WriteAsync(header, 0, header.Length), handle, deadline, check);
        WaitPipe(pipe.WriteAsync(body, 0, length), handle, deadline, check);
    }

    private static byte[] ReadLine(Func<byte[], int> read, string prefix, int limit, bool rejectExtra) {
        int encodedLimit = ((limit + 2) / 3) * 4;
        var line = new char[prefix.Length + encodedLimit + 1]; // optional CR before LF
        var chunk = new byte[4096];
        int count = 0;
        while (true) {
            int n = read(chunk);
            if (n <= 0) throw new BridgeFailure();
            for (int i = 0; i < n; i++) {
                int b = chunk[i];
                if (b == '\n') {
                    if (rejectExtra && i + 1 != n) throw new BridgeFailure();
                    return DecodeLine(line, count, prefix, limit);
                }
                if (b > 127 || count == line.Length) throw new BridgeFailure();
                line[count++] = (char)b;
            }
        }
    }

    private static byte[] DecodeLine(char[] line, int end, string prefix, int limit) {
        if (end > 0 && line[end - 1] == '\r') end--;
        int start = prefix.Length, length = end - start;
        if (length < 4 || length % 4 != 0) throw new BridgeFailure();
        for (int i = 0; i < start; i++) if (line[i] != prefix[i]) throw new BridgeFailure();
        int padding = line[end - 1] == '=' ? (line[end - 2] == '=' ? 2 : 1) : 0;
        if (length / 4 * 3 - padding > limit) throw new BridgeFailure();
        for (int i = start; i < end - padding; i++) if (Base64Alphabet.IndexOf(line[i]) < 0) throw new BridgeFailure();
        if (padding != 0 && (Base64Alphabet.IndexOf(line[end - padding - 1]) & (padding == 2 ? 15 : 3)) != 0)
            throw new BridgeFailure();
        return Convert.FromBase64CharArray(line, start, length);
    }

    private static void Emit(IntPtr output, string line, Action check) {
        var bytes = Encoding.ASCII.GetBytes(line + "\n");
        // Child stdio may be synchronous. A blocked output is terminal, never retried on another
        // connection. The worker is a background thread and cannot keep the helper process alive.
        Wait(Task.Run(() => {
            uint written;
            if (!WriteFile(output, bytes, (uint)bytes.Length, out written, IntPtr.Zero) || written != bytes.Length)
                throw new BridgeFailure();
        }), new Deadline(OutputMs), check);
    }

    private sealed class DesktopInput {
        private readonly SafeProcessHandle owner;
        private readonly IntPtr input = StandardHandle(StdInput);
        public DesktopInput(SafeProcessHandle owner) { this.owner = owner; }

        private static void CheckInputError(int error) {
            if (error == BrokenPipe || error == NoData || error == PipeNotConnected) throw new DesktopClosed();
            throw new BridgeFailure();
        }

        private uint Available() {
            if (!Live(owner)) throw new DesktopClosed();
            uint available;
            if (!PeekNamedPipe(input, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero))
                CheckInputError(Marshal.GetLastWin32Error());
            return available;
        }

        public void Idle() { if (Available() != 0) throw new BridgeFailure(); }
        public void Pending() { Available(); }

        public byte[] ReadReply() {
            var deadline = new Deadline(ParentReplyMs);
            return ReadLine(buffer => {
                while (true) {
                    int wait = deadline.NextWait();
                    uint available = Available();
                    if (available == 0) { Thread.Sleep(wait); continue; }
                    // We are the sole reader. Never issue a synchronous read for bytes not in the pipe.
                    uint n;
                    if (!ReadFile(input, buffer, Math.Min(available, (uint)buffer.Length), out n, IntPtr.Zero))
                        CheckInputError(Marshal.GetLastWin32Error());
                    if (n == 0) throw new DesktopClosed();
                    return (int)n;
                }
            }, "reply ", ReplyLimit, true);
        }
    }

    private static SafePipeHandle CreateServer(string name, SecurityIdentifier user) {
        IntPtr descriptor;
        // An explicit owner and protected one-user DACL, not the token's default DACL.
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:" + user.Value + "D:P(A;;GA;;;" + user.Value + ")", 1, out descriptor, IntPtr.Zero))
            throw new BridgeFailure();
        try {
            var security = new SecurityAttributes {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, InheritHandle = 0
            };
            return CreateNamedPipeW(@"\\.\pipe\" + name, Duplex | FirstInstance | Overlapped, RejectRemoteClients, 1,
                RequestLimit, RequestLimit, 0, ref security);
        } finally { LocalFree(descriptor); }
    }

    private static int Serve(string name, uint parentPid, uint pid, long started, SecurityIdentifier user) {
        using (var owner = Open(parentPid)) {
            if (parentPid == pid || !Live(owner) || Birth(owner) > started || !user.Equals(User(owner))) return Unavailable;
            var desktop = new DesktopInput(owner);
            var output = StandardHandle(StdOutput);
            bool pending = false;
            try {
                desktop.Idle();
                using (var handle = CreateServer(name, user)) {
                    if (handle.IsInvalid) throw new BridgeFailure();
                    using (var server = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle)) {
                        Emit(output, "ready " + pid.ToString(CultureInfo.InvariantCulture) + " " + started.ToString(CultureInfo.InvariantCulture), desktop.Idle);
                        while (true) {
                            try { WaitPipe(server.WaitForConnectionAsync(), handle, null, desktop.Idle); }
                            catch (IOException e) {
                                // A client can connect and close before ConnectNamedPipe sees it.
                                if (e.HResult != unchecked((int)(0x80070000u | NoData))) throw;
                                if (!DisconnectNamedPipe(handle) && Marshal.GetLastWin32Error() != PipeNotConnected)
                                    throw new BridgeFailure();
                                continue;
                            }

                            byte[] request = null;
                            try { request = ReadFrame(server, handle, RequestLimit, new Deadline(RequestMs), desktop.Idle); }
                            catch (IOException) { }
                            catch (TimeoutException) { }
                            if (request != null) {
                                desktop.Idle();
                                pending = true;
                                Emit(output, "request " + Convert.ToBase64String(request), desktop.Pending);
                                // Even if the client has since left, consume its one valid desktop reply
                                // or stop. An unanswered request can never be followed by another.
                                byte[] reply = desktop.ReadReply();
                                pending = false;
                                desktop.Idle();
                                try {
                                    WriteFrame(server, handle, reply, new Deadline(ReplyWriteMs), desktop.Idle);
                                    // DisconnectNamedPipe drops unread bytes. Call closes promptly after
                                    // reading the reply, so wait for EOF (bounded; no extra wire ACK).
                                    var discard = new byte[1];
                                    WaitPipe(server.ReadAsync(discard, 0, 1), handle, new Deadline(PeerCloseMs), desktop.Idle);
                                } catch (IOException) { }
                                catch (TimeoutException) { }
                            }
                            server.Disconnect();
                        }
                    }
                }
            } catch (DesktopClosed) { return pending ? Unavailable : 0; }
        }
    }

    private static int Call(string name, uint expectedPid, long expectedStarted, SecurityIdentifier user) {
        var input = Task.Run(() => {
            using (var stream = Console.OpenStandardInput())
                return ReadLine(buffer => stream.Read(buffer, 0, buffer.Length), "request ", RequestLimit, false);
        });
        Wait(input, new Deadline(InputMs), null);
        byte[] reply;
        // Hold the candidate process before connecting, then tie it to this connection's kernel
        // server PID. Missing or unreadable process metadata is never accepted as a match.
        using (var owner = Open(expectedPid))
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous,
            TokenImpersonationLevel.Identification, HandleInheritability.None)) {
            pipe.Connect(ConnectMs);
            var handle = pipe.SafePipeHandle;
            uint actual;
            if (!GetNamedPipeServerProcessId(handle, out actual) || actual == 0) throw new BridgeFailure();
            if (actual != expectedPid || Birth(owner) != expectedStarted || !user.Equals(User(owner))) return Mismatch;
            Action check = () => { if (!Live(owner)) throw new BridgeFailure(); };
            var deadline = new Deadline(CallExchangeMs);
            WriteFrame(pipe, handle, input.Result, deadline, check);
            reply = ReadFrame(pipe, handle, ReplyLimit, deadline, check);
        }
        Emit(StandardHandle(StdOutput), "reply " + Convert.ToBase64String(reply), null);
        return 0;
    }

    public static int Run(string mode, string name, string parent, string expected, string birth) {
        if (name == null || !Regex.IsMatch(name, @"\Avocs-code-local-[a-f0-9]{32}\z", RegexOptions.CultureInvariant)) return Unavailable;
        uint pid = GetCurrentProcessId(), target;
        long started;
        using (var self = Open(pid)) {
            if (mode == "Serve" && String.IsNullOrEmpty(expected) && String.IsNullOrEmpty(birth) &&
                UInt32.TryParse(parent, NumberStyles.None, CultureInfo.InvariantCulture, out target) && target > 0)
                return Serve(name, target, pid, Birth(self), User(self));
            if (mode == "Call" && String.IsNullOrEmpty(parent) &&
                UInt32.TryParse(expected, NumberStyles.None, CultureInfo.InvariantCulture, out target) && target > 0 &&
                Int64.TryParse(birth, NumberStyles.None, CultureInfo.InvariantCulture, out started) && started > 0)
                return Call(name, target, started, User(self));
            return Unavailable;
        }
    }
}
'@
    exit ([VocsLocalWindowsPipe]::Run($Mode, $PipeName, $ParentPid, $ExpectedPid, $ExpectedStarted))
} catch {
    # No input, profile, endpoint or native exception details on stdout or stderr.
    exit 4
}
