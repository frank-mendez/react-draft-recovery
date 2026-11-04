import { setTimeout } from 'node:timers/promises';

const output = value => typeof value === 'string' ? value : value?.toString?.() ?? '';

function isRegistryNotFound(error) {
  let code;
  try { code = JSON.parse(output(error.stdout)).error?.code; } catch { /* Not an npm JSON error. */ }
  if (code === 'E404') return true;

  return /\bnpm error code E404\b/i.test(`${output(error.stdout)}\n${output(error.stderr)}`);
}

// Retry temporary registry propagation failures, never auth or integrity errors.
export async function retryRegistryOperation(operation, { attempts = 12, delay = 10000, wait = setTimeout } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRegistryNotFound(error) || attempt === attempts) throw error;
      console.log(`Registry resource not visible yet; retrying (${attempt}/${attempts})`);
      await wait(delay);
    }
  }
}

export function readRegistryMetadata(read, options) {
  return retryRegistryOperation(read, options);
}
