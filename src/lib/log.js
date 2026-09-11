const fs = require('fs');
const path = require('path');

const logsDirPath = path.join(__dirname, '../../logs/');
const maxLogSizeBytes = 25 * 1024 * 1024;
const writeQueues = new Map();

function writeFallback(message) {
  try {
    process.stderr.write(`${message}\n`);
  } catch (stderrError) {
    // There is no safer destination left if stderr itself is unavailable.
  }
}

function ensureString(parameter) {
  if (typeof parameter === 'string') return parameter;
  try {
    const serialized = JSON.stringify(parameter);
    return typeof serialized === 'string' ? serialized : String(parameter);
  } catch (serializationError) {
    return String(parameter);
  }
}

function writeToFile(filepath, args) {
  let entry = `${new Date().toISOString()}          ${ensureString(args?.message || args)}\n`;
  if (args?.stack && typeof args.stack === 'string') {
    entry += `${args.stack}\n`;
  }
  const previousWrite = writeQueues.get(filepath) || Promise.resolve();
  const queuedWrite = previousWrite
    .then(async () => {
      await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
      let size = 0;
      try {
        size = (await fs.promises.stat(filepath)).size;
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      if (size > maxLogSizeBytes) {
        await fs.promises.writeFile(filepath, entry, 'utf8');
      } else {
        await fs.promises.appendFile(filepath, entry, 'utf8');
      }
    })
    .catch((writeError) => {
      writeFallback(`Log write failed for ${filepath}: ${writeError.stack || writeError.message || writeError}`);
    })
    .finally(() => {
      if (writeQueues.get(filepath) === queuedWrite) writeQueues.delete(filepath);
    });
  writeQueues.set(filepath, queuedWrite);
  return queuedWrite;
}

async function flush() {
  await Promise.all(Array.from(writeQueues.values()));
}

function debug(args) {
  try {
    console.log(args);
    // write to file
    const filepath = `${logsDirPath}debug.log`;
    writeToFile(filepath, args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function error(...args) {
  try {
    // Process multiple arguments and handle various error types
    let message = '';

    args.forEach((arg, index) => {
      if (arg === null) {
        message += 'null';
      } else if (arg === undefined) {
        message += 'undefined';
      } else if (arg instanceof Error) {
        // Handle Error objects
        message += arg.stack || arg.message || arg.toString();
      } else if (typeof arg === 'object') {
        // Handle regular objects
        try {
          message += JSON.stringify(arg, null, 2);
        } catch (e) {
          message += arg.toString();
        }
      } else {
        // Handle strings, numbers, etc.
        message += String(arg);
      }

      // Add space between arguments
      if (index < args.length - 1) {
        message += ' ';
      }
    });

    // console.error(message);
    // write to file
    const filepath = `${logsDirPath}error.log`;
    writeToFile(filepath, message);
    debug(message);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function warn(args) {
  try {
    // console.warn(args);
    // write to file
    const filepath = `${logsDirPath}warn.log`;
    writeToFile(filepath, args);
    debug(args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function info(args) {
  try {
    // console.log(args);
    // write to file
    const filepath = `${logsDirPath}info.log`;
    writeToFile(filepath, args);
    debug(args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function bugtrack(args) {
  try {
    // console.log(args);
    // write to file
    const filepath = `${logsDirPath}bugtrack.log`;
    writeToFile(filepath, args);
    debug(args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function bugtrackB(args) {
  try {
    // console.log(args);
    // write to file
    const filepath = `${logsDirPath}bugtrackB.log`;
    writeToFile(filepath, args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function bugtrackC(args) {
  try {
    // console.log(args);
    // write to file
    const filepath = `${logsDirPath}bugtrackC.log`;
    writeToFile(filepath, args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

module.exports = {
  error,
  warn,
  info,
  debug,
  bugtrack,
  bugtrackB,
  bugtrackC,
  flush,
  testHooks: {
    ensureString,
    writeToFile,
  },
};
