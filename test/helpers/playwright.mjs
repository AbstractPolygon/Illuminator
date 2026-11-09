// One place that finds Playwright and launches Chromium for the browser/GPU tests, so the twelve test files do not each carry a copy.
//
// Skip policy: where no browser is available a test skips with a clear reason, except when CI is set. There a missing
// browser must fail, otherwise a broken install silently turns the whole GPU suite into skips (which is how it went unnoticed
// before). ILLUMINATOR_SKIP_BROWSER_TESTS=1 is the explicit opt-out for CI jobs that deliberately run elsewhere
// (the installer matrix, where downloading browsers would only slow builds); it wins over CI.
import fs from 'node:fs';
import path from 'node:path';

// SwiftShader gives headless Chromium a software WebGL2 context on machines without a GPU (CI runners, containers).
export const BROWSER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

async function loadPlaywright() {
  // The repo's devDependency first; the fixed path is only the preinstalled copy of the sandbox this was developed in.
  for (const spec of ['playwright', '/opt/node-tools/node_modules/playwright/index.mjs']) {
    try {
      return await import(spec);
    } catch {}
  }
  return null;
}

// A preinstalled browser (sandbox images keep one under /opt/pw-browsers); null means use Playwright's own download.
function preinstalledChromium() {
  const base = '/opt/pw-browsers';
  try {
    const link = path.join(base, 'chromium');
    if (fs.existsSync(link)) return link;
    for (const d of fs.readdirSync(base).sort().reverse()) {
      if (!/^chromium-\d+$/.test(d)) continue;
      const exe = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return null;
}

// Launches Chromium for a test. Returns the browser, or null after skipping (or failing, on CI) the test: callers do `if (!browser) return;`.
export async function launchBrowser(t) {
  const unavailable = (reason) => {
    if (process.env.ILLUMINATOR_SKIP_BROWSER_TESTS) {
      t.skip('Browser tests are switched off here (ILLUMINATOR_SKIP_BROWSER_TESTS)');
      return null;
    }
    if (process.env.CI) throw new Error(`${reason}, and the browser tests must not be skipped on CI. Run "npx playwright install --with-deps chromium".`);
    t.skip(`${reason}; run "npm ci" and "npx playwright install chromium" to run this test`);
    return null;
  };
  if (process.env.ILLUMINATOR_SKIP_BROWSER_TESTS) return unavailable('');
  const pw = await loadPlaywright();
  if (!pw) return unavailable('Playwright is not installed');
  const pre = preinstalledChromium();
  const attempts = pre ? [{ executablePath: pre }, {}] : [{}];
  let last;
  for (const extra of attempts) {
    try {
      return await pw.chromium.launch({ args: BROWSER_ARGS, ...extra });
    } catch (e) {
      last = e;
    }
  }
  return unavailable(`Chromium could not start (${String(last && last.message).split('\n')[0]})`);
}
