import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const temp = mkdtempSync(join(tmpdir(), 'draft-recovery-adoption-'));
const project = join(temp, 'consumer');
const run = (command, args, cwd, options = {}) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      ...options,
    });
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    throw error;
  }
};

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = server.address();
  await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return port;
}

async function waitForServer(server, url, output) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited before ready:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* The server is still starting. */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite did not become ready:\n${output.join('')}`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  await new Promise(resolvePromise => {
    server.once('exit', resolvePromise);
    server.kill('SIGTERM');
  });
}

let server;
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], root));
  const archive = join(temp, packed.filename);
  cpSync(join(root, 'adoption/consumer'), project, { recursive: true });
  const testArgs = process.argv.slice(2).filter(argument => argument !== '--');
  const variants = [
    { reactVersion: '19.2.0', lockfile: 'package-lock.json' },
    { reactVersion: '18.3.1', lockfile: 'package-lock.react18.json' },
  ];
  for (const variant of variants) {
    const manifestPath = join(project, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies.react = variant.reactVersion;
    manifest.dependencies['react-dom'] = variant.reactVersion;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (variant.lockfile !== 'package-lock.json') {
      cpSync(join(project, variant.lockfile), join(project, 'package-lock.json'));
    }
    run('npm', ['ci', '--no-audit', '--no-fund'], project);
    run('npm', [
      'install', '--no-save', '--no-audit', '--no-fund', '--package-lock=false', archive,
    ], project);

    const port = await freePort();
    const vite = join(project, 'node_modules/vite/bin/vite.js');
    const output = [];
    server = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: project,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => output.push(chunk.toString()));
    server.stderr.on('data', chunk => output.push(chunk.toString()));
    const url = `http://127.0.0.1:${port}`;
    await waitForServer(server, url, output);

    console.log(`Adoption consumer ${packed.filename} with React ${variant.reactVersion}; running Chromium checks.`);
    run(process.execPath, ['--test', ...testArgs, 'adoption/consumer.browser.mjs'], root, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ADOPTION_URL: url,
        ADOPTION_REACT_VERSION: variant.reactVersion,
      },
    });
    await stopServer(server);
    server = null;
  }
} finally {
  await stopServer(server);
  rmSync(temp, { recursive: true, force: true });
}
