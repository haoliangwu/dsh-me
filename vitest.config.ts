import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Component specs stub the platform primitives instead of pulling the
      // real renderer into the test environment.
      '@deepseek-ai/dsh-client-ui-primitives': new URL('./vitest.stub.ts', import.meta.url).pathname,
    },
  },
})
