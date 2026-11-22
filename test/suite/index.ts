import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

export const run = (): Promise<void> => new Promise((resolve, reject) => {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30000 });
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js'))) {
    mocha.addFile(path.join(__dirname, f));
  }
  mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve()));
});
