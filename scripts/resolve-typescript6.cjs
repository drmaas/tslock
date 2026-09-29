'use strict';

const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'typescript') {
    return originalLoad.call(this, '@typescript/typescript6', parent, isMain);
  }
  return originalLoad.call(this, request, parent, isMain);
};
