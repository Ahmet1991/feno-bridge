const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Only source-defined names and numeric timings may enter CI output.
const phases = new Set(('windows_trust application_imports user_data_migration single_instance_lock debug_port electron_ready runtime_source runtime_install runtime_source_hash runtime_install_hash runtime_install_copy runtime_install_stage_hash runtime_install_final_hash runtime_install_receipt runtime_install_metadata runtime_background_hash state_and_autostart smoke_browser smoke_renderer smoke_runtime_version smoke_daemon_start smoke_daemon_stop smoke_browser_cleanup').split(' '));
const events = new Set(('launcher.boot_started launcher.boot_phase_started launcher.boot_phase_finished launcher.boot_wait launcher.runtime_background_rejected launcher.smoke_failed browser.initialization_retry browser.initialization_recovered browser.initialization_failed browser.initialized browser.renderer_gone browser.surface_mark_failed runtime.daemon_started runtime.daemon_exited runtime.daemon_process_error runtime.daemon_stdout runtime.daemon_stderr runtime.daemon_stdout_unavailable runtime.daemon_stderr_unavailable runtime.daemon_forced_stop runtime.startup_failed runtime.setup_required runtime.state_write_failed runtime.external_owner_detected runtime.forced_shutdown_started runtime.forced_shutdown_completed runtime.start_failed_before_stop runtime.stale_owner_recovery_started runtime.stale_owner_recovered pc_control.smoke_service_started').split(' '));
const codes = new Set(['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'EADDRINUSE', 'ECONNRESET', 'ABORT_ERR', 'LAUNCHER_EXIT', 'runtime_integrity_mismatch']);
events.add('launcher.single_instance_lock_call');
events.add('launcher.single_instance_lock_return');
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
          if (record.event === 'launcher.single_instance_lock_return' && typeof detail.gotLock === 'boolean') safe.gotLock = detail.gotLock;
          records.push(safe);
        } catch { /* incomplete or malformed record */ }
      }
    } catch { /* log not yet created */ }
  }
  return { events: records.slice(-60), phases: records.filter(r => r.event === 'launcher.boot_phase_finished' && r.phase && Number.isFinite(r.durationMs)).slice(-120) };
}

// Chromium places SingletonSocket below TMPDIR, not below the profile. Keep
// the durable runtime in the workspace, but reserve a short private socket root.
function makeSmokeTemp(platform, workspaceTemp, mkdir = fs.mkdtempSync) {
  return platform === 'linux' ? mkdir('/tmp/feno-smoke-') : workspaceTemp;
}

function linuxSmokeOptions(executable, env) {
  return { args: ['-a', executable, '--launcher-smoke-test', '--enable-logging=stderr'],
    env: {...env, APPIMAGE_EXTRACT_AND_RUN: '1', ELECTRON_ENABLE_LOGGING: '1'} };
}

const outputPatterns = [
  ['socket_path_too_long', /socket path too long|ENAMETOOLONG/i],
  ['process_singleton', /process.?singleton|SingletonLock|SingletonSocket|SingletonCookie/i],
  ['socket_bind', /failed to bind|EADDRINUSE/i],
  ['socket_directory', /failed to create socket directory/i],
  ['singleton_symlink', /failed to create symlinks/i],
  ['dbus', /D-Bus|dbus/i], ['display', /xvfb|X11|display/i],
  ['sandbox', /sandbox/i], ['crash', /fatal|segmentation fault|crash|check failed/i],
  ['permission', /permission denied|EACCES|EPERM/i],
];
function summarizeOutput(value) {
  return String(value ?? '').split(/\r?\n/).filter(Boolean).slice(-80).map(line => {
    const categories = outputPatterns.filter(([, re]) => re.test(line)).map(([name]) => name);
    // Arbitrary Chromium messages can include paths, URLs, command lines and tokens.
    // Emit only fixed diagnostic terms; even an unknown line is counted.
    return categories.length ? categories.join(',') : 'redacted';
  });
}

function safeCommand(value) {
  const args = String(value).split(/\0|\s+/).filter(Boolean);
  const exe = path.posix.basename(args[0] || '');
  const executable = /^(?:feno(?:-bridge)?(?:-[\d.]+-linux-x64\.AppImage)?|electron|chrome(?:-sandbox|_crashpad_handler)?|xvfb-run|Xvfb|AppRun|sh|bash|bun|node|fusermount3?)$/i.test(exe) ? exe : 'other';
  const switches = args.filter(arg => /^(?:--launcher-smoke-test|--enable-logging=stderr|--type=(?:renderer|gpu-process|utility|zygote)|--no-sandbox|--appimage-extract|-a)$/.test(arg));
  return [executable, ...switches.slice(0,8)].join(' ');
}

function singletonEntries(dir, filesystem = fs) {
  return ['SingletonLock','SingletonCookie','SingletonSocket'].map(name => {
    try {
      const file = path.join(dir, name);
      const stat = filesystem.lstatSync(file);
      if (!stat.isSymbolicLink()) return {name, type:'non_symlink'};
      const target = filesystem.readlinkSync(file);
      const info = {name, type:'symlink', targetBytes:Buffer.byteLength(target)};
      if (name === 'SingletonLock') {
        const owner = /-(\d+)$/.exec(target);
        if (owner) info.ownerPid = Number(owner[1]);
      } else if (name === 'SingletonSocket') {
        info.absolute = path.posix.isAbsolute(target);
        info.socketName = path.posix.basename(target) === 'SingletonSocket';
        info.exists = filesystem.existsSync(file);
      }
      return info;
    } catch (error) { return {name, type:error.code === 'ENOENT' ? 'missing' : 'unreadable'}; }
  });
}

function summarizePs(value) {
  return String(value ?? '').split(/\r?\n/).filter(line => /feno|AppImage|electron|chrome/i.test(line)).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z+<NLsl]+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) return null;
    return {pid:Number(match[1]),ppid:Number(match[2]),state:match[3],elapsedSeconds:Number(match[4]),comm:safeCommand(match[5]),cmdline:safeCommand(match[6])};
  }).filter(Boolean).slice(0,100);
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
      result.set(pid, { parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19], state:fields[0] });
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
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore','pipe','pipe'] });
  const output = {stdout:'',stderr:''};
  for (const name of ['stdout','stderr']) child[name].on('data', chunk => {
    output[name] = (output[name] + chunk.toString()).slice(-256*1024);
  });
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
      // Capture evidence while processes and Chromium's lock still exist.
      try {
        const snapshot = sample();
        const tree = [...known].filter(([pid,start]) => snapshot.get(pid)?.start === start).map(([pid]) => {
          const read = name => { try { return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8').trim(); } catch { return ''; } };
          const wchan = read('wchan');
          return {pid, ppid:snapshot.get(pid).parent, state:snapshot.get(pid).state,
            wchan:/^[a-zA-Z0-9_]{1,80}$/.test(wchan) ? wchan : 'unknown', cmdline:safeCommand(read('cmdline'))};
        });
        const ps = spawnSync('ps',['-eo','pid,ppid,stat,etimes,comm,args'],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024});
        console.log('PACKAGED_LINUX_LOCK_DIAGNOSTICS '+JSON.stringify({tree,ps:summarizePs(ps.stdout),singleton:singletonEntries(options.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR || options.cwd),stdout:summarizeOutput(output.stdout),stderr:summarizeOutput(output.stderr)}));
      } catch { console.log('PACKAGED_LINUX_LOCK_DIAGNOSTICS_FAILED'); }
      signal('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
      signal('SIGKILL');
      // Let the kernel terminate the signalled processes before reading the
      // synchronously appended launcher log. Never wait indefinitely on pipes.
      await new Promise(resolve => setTimeout(resolve, 250));
    } finally { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
    throw error;
  } finally { clearInterval(interval); clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); }
}

module.exports = { summarizeLauncherLog, rememberTree, runLinuxLauncher, safeErrorCode, makeSmokeTemp, linuxSmokeOptions, summarizeOutput, singletonEntries, summarizePs, safeCommand };
