'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Mocha = require('mocha');

exports.run = () => new Promise((resolve, reject) => {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30000 });
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js'))) {
    mocha.addFile(path.join(__dirname, f));
  }
  mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve()));
});
