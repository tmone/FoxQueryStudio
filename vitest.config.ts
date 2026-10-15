import { defineConfig } from 'vitest/config';

// Integration tests start FoxPro processes and talk to a SQL Server; under a full run they need more than the 5 s default.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 120_000 } });
