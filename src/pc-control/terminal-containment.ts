import path from 'node:path';
import type {PcCommandSpec} from './jobs';

/** Containment is supplied by job-native for every command, never by a script wrapper. */
export function containedWindowsTerminalSpec(command:string,_timeoutMs?:number):PcCommandSpec {
  const completion='\n$__fenoLastStatementSucceeded = $?\nif (-not $__fenoLastStatementSucceeded) { if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }';
  return {command:path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    args:['-NoLogo','-NoProfile','-NonInteractive','-Command',command+completion],usesEmulator:false};
}
