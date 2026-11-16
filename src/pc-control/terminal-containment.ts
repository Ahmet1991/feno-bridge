import path from 'node:path';
import type {PcCommandSpec} from './jobs';

/** Containment is supplied by job-native for every command, never by a script wrapper. */
export function containedWindowsTerminalSpec(command:string,_timeoutMs?:number):PcCommandSpec {
  // Only a single, simple GUI launch is eligible. A general script remains fully
  // contained so its descendants are killed when the job is cancelled or times out.
  const guiCommand=/^(?:notepad\.exe(?:\s+[^;|&\r\n]*)?|cmd(?:\.exe)?\s+\/[dc]\s+start\s+(?:""\s+)?(?:chrome|msedge)(?:\.exe)?(?:\s+[^;|&\r\n]*)?)\s*$/i.test(command.trim());
  const completion='\n$__fenoLastStatementSucceeded = $?\nif (-not $__fenoLastStatementSucceeded) { if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }';
  return {command:path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    // Force both PowerShell's pipeline and native-child streams to UTF-8.
    args:['-NoLogo','-NoProfile','-NonInteractive','-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'+
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'+command+completion],usesEmulator:false,allowGuiBreakaway:guiCommand};
}
