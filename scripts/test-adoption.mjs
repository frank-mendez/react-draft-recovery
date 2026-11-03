import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
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

let server;
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], root));
  const archive = join(temp, packed.filename);
  cpSync(join(root, 'adoption/consumer'), project, { recursive: true });
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

  console.log(`Adoption consumer installed from ${packed.filename}; running Chromium checks.`);
  const testArgs = process.argv.slice(2).filter(argument => argument !== '--');
  run(process.execPath, ['--test', ...testArgs, 'adoption/consumer.browser.mjs'], root, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ADOPTION_URL: url,
    },
  });
} finally {
  server?.kill('SIGTERM');
  rmSync(temp, { recursive: true, force: true });
}
