import { rmSync } from 'node:fs';

export function removeSmokeDirectory(directory: string) {
  if (process.env.FENO_KEEP_SMOKE_DIR === '1') {
    console.log('Smoke directory retained: ' + directory);
    return;
  }
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn('Could not remove smoke directory ' + directory + ': ' + String(error));
  }
}
