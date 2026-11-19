const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Only source-defined names and numeric timings may enter CI output.
const phases = new Set(('windows_trust application_imports user_data_migration single_instance_lock debug_port electron_ready runtime_source runtime_install runtime_source_hash runtime_install_hash runtime_install_copy runtime_install_stage_hash runtime_install_final_hash runtime_install_receipt runtime_install_metadata runtime_background_hash state_and_autostart smoke_browser smoke_renderer smoke_runtime_version smoke_daemon_start smoke_daemon_stop smoke_browser_cleanup').split(' '));
const events = new Set(('launcher.boot_started launcher.boot_phase_started launcher.boot_phase_finished launcher.boot_wait launcher.runtime_background_rejected launcher.smoke_failed browser.initialization_retry browser.initialization_recovered browser.initialization_failed browser.initialized browser.renderer_gone browser.surface_mark_failed runtime.daemon_started runtime.daemon_exited runtime.daemon_process_error runtime.daemon_stdout runtime.daemon_stderr runtime.daemon_stdout_unavailable runtime.daemon_stderr_unavailable runtime.daemon_forced_stop runtime.startup_failed runtime.setup_required runtime.state_write_failed runtime.external_owner_detected runtime.forced_shutdown_started runtime.forced_shutdown_completed runtime.start_failed_before_stop runtime.stale_owner_recovery_started runtime.stale_owner_recovered pc_control.smoke_service_started').split(' '));
const codes = new Set(['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'EADDRINUSE', 'ECONNRESET', 'ABORT_ERR', 'LAUNCHER_EXIT', 'runtime_integrity_mismatch']);
const safeErrorCode = error => codes.has(error?.code) ? error.code : 'SMOKE_FAILED';

function summarizeLauncherLog(file) {
  const records = [];
  for (const name of [file + '.1', file]) {
    try {
      for (const line of fs.readFileSync(name, 'utf8').split(/\r?\n/)) {
        try {
          const record = JSON.parse(line);
          if (!record || typeof record.event !== 'string') continue;
          const detail = record.detail || {};
          const safe = { event: events.has(record.event) ? record.event : 'other' };
          if (phases.has(detail.phase)) safe.phase = detail.phase;
          for (const key of ['durationMs', 'elapsedMs', 'waitMs']) {
            if (Number.isFinite(detail[key]) && detail[key] >= 0) safe[key] = detail[key];
          }
          if (codes.has(detail.code)) safe.code = detail.code;
          records.push(safe);
        } catch { /* incomplete or malformed record */ }
      }
    } catch { /* log not yet created */ }
  }
  return { events: records.slice(-60), phases: records.filter(r => r.event === 'launcher.boot_phase_finished' && r.phase && Number.isFinite(r.durationMs)).slice(-120) };
}

// Linux children can call setsid (the runtime supervisor does). Track their
// identities as well as the original session, never kill by process name.
function linuxProcesses() {
  const result = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const pid = Number(name);
      result.set(pid, { parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19] });
    } catch { /* exited or inaccessible */ }
  }
  return result;
}

function rememberTree(root, known, snapshot) {
  const rootInfo = snapshot.get(root);
  if (!known.has(root) && rootInfo?.session === root) known.set(root, rootInfo.start);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, info] of snapshot) {
      if (known.has(pid)) continue;
      const parent = snapshot.get(info.parent);
      if ((known.has(info.parent) && parent?.start === known.get(info.parent)) ||
          (known.has(root) && rootInfo?.start === known.get(root) && info.session === root)) {
        known.set(pid, info.start);
        changed = true;
      }
    }
  }
}

async function runLinuxLauncher(command, args, options) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: 'ignore' });
  const known = new Map();
  const sample = () => { const snapshot = linuxProcesses(); rememberTree(child.pid, known, snapshot); return snapshot; };
  const signal = (name) => {
    const snapshot = sample();
    for (const [pid, start] of known) {
      if (snapshot.get(pid)?.start !== start) continue;
      try { process.kill(pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  let timer, interval;
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signalName) => {
        if (status === 0) resolve();
        else reject(Object.assign(new Error('Linux launcher exited unsuccessfully'), { code: 'LAUNCHER_EXIT', status, signal: signalName }));
      });
      child.once('spawn', () => { try { sample(); } catch (error) { reject(error); } });
      interval = setInterval(() => { try { sample(); } catch (error) { reject(error); } }, 250);
      timer = setTimeout(() => reject(Object.assign(new Error('Linux launcher exceeded smoke deadline'), { code: 'ETIMEDOUT' })), options.timeout);
    });
  } catch (error) {
    try {
      signal('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
      signal('SIGKILL');
      // Let the kernel terminate the signalled processes before reading the
      // synchronously appended launcher log. Never wait indefinitely on pipes.
      await new Promise(resolve => setTimeout(resolve, 250));
    } finally { child.unref(); }
    throw error;
  } finally { clearInterval(interval); clearTimeout(timer); }
}

module.exports = { summarizeLauncherLog, rememberTree, runLinuxLauncher, safeErrorCode };
