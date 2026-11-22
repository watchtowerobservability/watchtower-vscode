import { defineConfig } from 'vitest/config';

// Unit tests only; test/suite runs inside the VS Code extension host (npm run test:vscode).
export default defineConfig({ test: { include: ['test/*.test.ts'] } });
