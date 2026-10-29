'use strict';
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

runTests({
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
  launchArgs: [path.resolve(__dirname, '..', 'examples', 'demo'), '--disable-extensions'],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
