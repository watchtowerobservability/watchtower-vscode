import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

// Compiled to dist/test/runTest.js: the package root is two levels up.
const root = path.resolve(__dirname, '..', '..');
runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
  launchArgs: [path.join(root, 'examples', 'demo'), '--disable-extensions'],
}).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
