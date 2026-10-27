import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // Vite emits a client-only example bundle; retain the source directive for RSC consumers.
        if (warning.code === 'SOURCEMAP_ERROR' && warning.id?.endsWith('/react/index.ts')) return;
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
        warn(warning);
      },
    },
  },
});
