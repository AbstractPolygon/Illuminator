// Reading and writing the settings file without losing it: writes go to a
// temporary file in the same folder and are renamed into place, the previous
// version is kept as .bak, and a file that cannot be parsed is kept as .bad
// instead of being silently replaced by defaults.

const fsp = require('node:fs/promises');
const path = require('node:path');

let counter = 0;

async function writeSettings(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${++counter}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.copyFile(file, `${file}.bak`).catch(() => {});
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// { settings, problem }: settings is null when there is nothing usable (first run, or both the file and its backup are unreadable); problem says what was found.
async function readSettings(file) {
  const parse = async (f) => JSON.parse(await fsp.readFile(f, 'utf8'));
  try {
    return { settings: await parse(file), problem: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: null, problem: null };
    if (!(err instanceof SyntaxError)) return { settings: null, problem: `unreadable: ${err.message}` };
    await fsp.rename(file, `${file}.bad`).catch(() => {});
    try {
      return { settings: await parse(`${file}.bak`), problem: `unreadable (kept as settings.json.bad), restored from the backup: ${err.message}` };
    } catch {
      return { settings: null, problem: `unreadable (kept as settings.json.bad): ${err.message}` };
    }
  }
}

module.exports = { readSettings, writeSettings };
