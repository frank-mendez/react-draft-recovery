import { setTimeout } from 'node:timers/promises';

// Retry only a newly published version's temporary absence, never auth or integrity errors.
export async function readRegistryMetadata(read, { attempts = 12, delay = 10000, wait = setTimeout } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return read();
    } catch (error) {
      let code;
      try { code = JSON.parse(error.stdout).error?.code; } catch { /* Not an npm JSON error. */ }
      if (code !== 'E404' || attempt === attempts) throw error;
      console.log(`Registry version not visible yet; retrying (${attempt}/${attempts})`);
      await wait(delay);
    }
  }
}
