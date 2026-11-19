const { mkdtempSync, rmSync } = require('node:fs');

module.exports = function trackTempDirectories(register) {
  const directories = [];
  register(() => {
    for (const directory of directories.splice(0).reverse()) {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        console.warn(`Could not remove test temp directory ${directory}: ${String(error)}`);
      }
    }
  });
  return prefix => {
    const directory = mkdtempSync(prefix);
    directories.push(directory);
    return directory;
  };
};
