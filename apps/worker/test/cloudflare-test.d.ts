/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Make `import { env } from 'cloudflare:test'` carry our Worker bindings.
declare namespace Cloudflare {
  type WorkerBindings = import('../src/types').Bindings;
  interface Env extends WorkerBindings {}
}
