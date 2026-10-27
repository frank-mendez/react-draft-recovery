import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
