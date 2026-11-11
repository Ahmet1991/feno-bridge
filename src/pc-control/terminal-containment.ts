import path from "node:path";
import type { PcCommandSpec } from "./jobs";

/*
 * Windows 10+ process-lifetime containment, not a filesystem/security sandbox.
 * The unnamed, non-inheritable job kills its process tree when this wrapper exits.
 * JOB_LIST assigns the child during CreateProcess itself: no uncontained startup
 * window, suspended orphan, breakaway permission, or uncontained fallback.
 * Keep this source embedded so runtime bundling needs no external helper install.
 * https://learn.microsoft.com/windows/win32/procthread/job-objects
 * https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
 */
const NATIVE_WRAPPER = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FenoContainedTerminal {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort ShowWindow, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {
    public Startup Startup;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
    bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr copy, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool result) {
    if (!result) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static IntPtr InheritedStandard(int kind) {
    IntPtr copy;
    Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out copy, 0, true, 2));
    return copy;
  }
  static void Close(IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); }

  public static int Run(string executable, string encodedCommand, int timeoutMs) {
    IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero;
    IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo();
    bool attributesInitialized = false;
    try {
      job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x00002000; // KILL_ON_JOB_CLOSE; deliberately no BREAKAWAY flags.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));

      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
      attributesInitialized = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));

      input = InheritedStandard(-10);
      output = InheritedStandard(-11);
      error = InheritedStandard(-12);
      StartupEx startup = new StartupEx();
      startup.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupEx));
      startup.Startup.Flags = 0x00000100; // STARTF_USESTDHANDLES
      startup.Startup.Input = input;
      startup.Startup.Output = output;
      startup.Startup.Error = error;
      startup.Attributes = attributes;
      StringBuilder command = new StringBuilder("\"" + executable + "\" -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encodedCommand);
      // Atomic assignment with EXTENDED_STARTUPINFO_PRESENT and CREATE_NO_WINDOW.
      Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000,
        IntPtr.Zero, null, ref startup, out process));
      Close(input); input = IntPtr.Zero;
      Close(output); output = IntPtr.Zero;
      Close(error); error = IntPtr.Zero;

      Stopwatch elapsed = Stopwatch.StartNew();
      bool timedOut = false;
      while (true) {
        Accounting accounting;
        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.ActiveProcesses == 0) break;
        if (!timedOut && elapsed.ElapsedMilliseconds >= timeoutMs) {
          Check(TerminateJobObject(job, 124));
          timedOut = true;
        }
        Thread.Sleep(25);
      }
      uint exitCode;
      Check(GetExitCodeProcess(process.Process, out exitCode));
      return timedOut ? 124 : unchecked((int)exitCode);
    } finally {
      Close(job); // Also terminates all assigned descendants on any failure.
      Close(process.Thread);
      Close(process.Process);
      Close(input); Close(output); Close(error);
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
    }
  }
}
`;

export function containedWindowsTerminalSpec(command: string, timeoutMs: number): PcCommandSpec {
  const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Encode command data separately: it can never alter the trusted wrapper or its native setup.
  // -EncodedCommand otherwise normalizes a failing final native program to 1.
  // Preserve that program's code, without reviving a stale code after a later
  // successful PowerShell statement. An explicit user exit still takes priority.
  const completion = "\n$__fenoLastStatementSucceeded = $?\nif (-not $__fenoLastStatementSucceeded) { if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }";
  const encoded = Buffer.from(command + completion, "utf16le").toString("base64");
  const script = `$ErrorActionPreference='Stop'\ntry {\nAdd-Type -TypeDefinition @'\n${NATIVE_WRAPPER}\n'@\nexit [FenoContainedTerminal]::Run('${executable.replaceAll("'", "''")}','${encoded}',${timeoutMs})\n} catch { [Console]::Error.WriteLine('pc_terminal_containment_failed: ' + $_.Exception.Message); exit 1 }`;
  return { command: executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], usesEmulator: false };
}
