const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../src/lib/log');

async function main() {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-log-test-'));
  const testFile = path.join(testDirectory, 'nested', 'test.log');
  const circular = { message: 'circular' };
  circular.self = circular;

  try {
    assert.strictEqual(log.testHooks.ensureString(circular), '[object Object]');
    await Promise.all([
      log.testHooks.writeToFile(testFile, 'first'),
      log.testHooks.writeToFile(testFile, 'second'),
      log.testHooks.writeToFile(testFile, circular),
    ]);
    await log.flush();
    const contents = fs.readFileSync(testFile, 'utf8');
    assert(contents.includes('first'));
    assert(contents.includes('second'));
    assert(contents.includes('circular'));
  } finally {
    fs.rmSync(testDirectory, { recursive: true, force: true });
  }

  console.log('Logging resilience tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
