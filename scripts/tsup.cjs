'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const shim = path.join(__dirname, 'resolve-typescript6.cjs');
const nodeOptions = `${process.env.NODE_OPTIONS || ''} --require ${shim}`.trim();

const result = spawnSync(process.execPath, [require.resolve('tsup/dist/cli-default.js'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
  },
});

process.exit(result.status === null ? 1 : result.status);
