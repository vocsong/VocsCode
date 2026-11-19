# Test-only: open an exact synthetic local pipe, never send a request or change its ACL.
param([string]$PipeName, [uint32]$ExpectedPid)

$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0 -or $ExpectedPid -eq 0 -or $PipeName -cnotmatch '\Avocs-code-local-[a-f0-9]{32}\z') {
    throw 'Expected a local pipe fixture name and server PID.'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class VocsLocalPipeProbe {
    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes {
        public IntPtr Sid;
        public uint Attributes;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(SafeAccessTokenHandle token, uint flags,
        uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete,
        uint restrictCount, ref SidAndAttributes restrict, out SafeAccessTokenHandle restricted);
    [DllImport("advapi32.dll")]
    private static extern bool IsTokenRestricted(SafeAccessTokenHandle token);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafePipeHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(SafePipeHandle pipe, uint objectType, uint information,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    private static extern int GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr ptr);

    private static RawSecurityDescriptor ReadDescriptor(SafePipeHandle pipe) {
        const uint fileObject = 1, ownerAndDacl = 5;
        IntPtr descriptor;
        uint error = GetSecurityInfo(pipe, fileObject, ownerAndDacl, IntPtr.Zero, IntPtr.Zero,
            IntPtr.Zero, IntPtr.Zero, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, "GetSecurityInfo");
        try {
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0);
        } finally { LocalFree(descriptor); }
    }

    private static SafePipeHandle Open(string name) {
        const uint genericReadWrite = 0xc0000000, openExisting = 3;
        const uint securityQosPresent = 0x100000, securityIdentification = 0x10000;
        return CreateFileW(@"\\.\pipe\" + name, genericReadWrite, 0, IntPtr.Zero,
            openExisting, securityQosPresent | securityIdentification, IntPtr.Zero);
    }

    private static SafeAccessTokenHandle Restrict(SafeAccessTokenHandle source) {
        if (IsTokenRestricted(source)) throw new InvalidOperationException("Expected an unrestricted control token.");
        var sid = new SecurityIdentifier(WellKnownSidType.RestrictedCodeSid, null);
        var bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        var buffer = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            var entry = new SidAndAttributes { Sid = buffer.AddrOfPinnedObject() };
            SafeAccessTokenHandle restricted;
            // Do not drop privileges or replace the user SID. Only add a restricting SID.
            if (!CreateRestrictedToken(source, 0, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, ref entry, out restricted))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateRestrictedToken");
            return restricted;
        } finally { buffer.Free(); }
    }

    public static void Check(string name, uint expectedPid) {
        using (var owner = WindowsIdentity.GetCurrent(TokenAccessLevels.Duplicate | TokenAccessLevels.Query))
        using (var reduced = Restrict(owner.AccessToken)) {
            using (WindowsIdentity.Impersonate(reduced.DangerousGetHandle())) {
                using (var effective = WindowsIdentity.GetCurrent(true)) {
                    if (effective == null || !owner.User.Equals(effective.User) || !IsTokenRestricted(effective.AccessToken))
                        throw new InvalidOperationException("Expected an effective restricted token for the same user.");
                }
                using (var rejected = Open(name)) {
                    int error = Marshal.GetLastWin32Error();
                    if (!rejected.IsInvalid) throw new InvalidOperationException("Restricted open unexpectedly succeeded.");
                    // A missing, busy, closed or inaccessible test setup is not proof of ACL denial.
                    if (error != 5) throw new Win32Exception(error, "Expected ERROR_ACCESS_DENIED for the restricted open (actual " + error + ").");
                }
            }
            // Positive control with identical access on the same live pipe, then read back the kernel ACL.
            using (var allowed = Open(name)) {
                if (allowed.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Owner open failed.");
                uint pid;
                if (!GetNamedPipeServerProcessId(allowed, out pid) || pid != expectedPid)
                    throw new InvalidOperationException("The opened pipe did not belong to the fixture helper.");
                var sd = ReadDescriptor(allowed);
                var acl = sd.DiscretionaryAcl;
                var ace = acl != null && acl.Count == 1 ? acl[0] as CommonAce : null;
                const ControlFlags expectedFlags = ControlFlags.DiscretionaryAclProtected | ControlFlags.DiscretionaryAclPresent;
                const int fileAllAccess = 0x001f01ff; // The kernel maps the helper's GA for file objects.
                if (!owner.User.Equals(sd.Owner) || (sd.ControlFlags & expectedFlags) != expectedFlags ||
                    ace == null || ace.AceType != AceType.AccessAllowed || ace.AceFlags != AceFlags.None ||
                    !owner.User.Equals(ace.SecurityIdentifier) || ace.AccessMask != fileAllAccess)
                    throw new InvalidOperationException("Expected a protected DACL granting only the owner file access.");
            }
        }
    }
}
'@
[VocsLocalPipeProbe]::Check($PipeName, $ExpectedPid)
Write-Output 'restricted denied; owner allowed; protected one-user DACL'
