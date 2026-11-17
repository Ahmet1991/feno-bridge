function createPcStartupRetry({ start, onFailure, schedule = setTimeout, cancel = clearTimeout }) {
  const delays = [5000, 15000, 60000, 300000];
  let timer, attempts = 0, stopped = false, ready = false;
  const attempt = () => {
    timer = undefined;
    if (stopped || ready) return;
    try { start(); ready = true; }
    catch (error) {
      const safe = (value, fallback) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : fallback;
      onFailure({ errorClass: safe(error?.constructor?.name, 'Error'), code: safe(error?.code, 'pc_security_initialization_failed') });
      timer = schedule(attempt, delays[Math.min(attempts++, delays.length - 1)]);
      timer?.unref?.();
    }
  };
  return { start() { if (timer === undefined) attempt(); }, stop() { stopped = true; if (timer !== undefined) cancel(timer); timer = undefined; } };
}
module.exports = { createPcStartupRetry };
