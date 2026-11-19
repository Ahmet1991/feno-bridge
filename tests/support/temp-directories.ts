import { mkdtempSync, rmSync } from 'node:fs';

// Each caller owns its own directories. Never sweep another test's or user's TEMP.
export function trackTempDirectories(register: (cleanup: () => void) => void) {
  const directories: string[] = [];
  register(() => {
    for (const directory of directories.splice(0).reverse()) {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        console.warn(`Could not remove test temp directory ${directory}: ${String(error)}`);
      }
    }
  });
  return (prefix: string): string => {
    const directory = mkdtempSync(prefix);
    directories.push(directory);
    return directory;
  };
}
