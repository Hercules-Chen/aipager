#!/usr/bin/env node
'use strict';
// aipagerctl — see `aipagerctl help`. Exit codes: 0 ok, 1 failure/task not succeeded, 2 usage, 3 dispatch cancelled by user.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`); });
require('../lib/ctl/cli').main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.stderr.write(`錯誤：${e.code ? e.code + ' ' : ''}${e.message}${e.traceId ? `（trace_id ${e.traceId}）` : ''}\n`);
    if (process.env.AIPAGER_DEBUG) process.stderr.write((e.stack || '') + '\n');
    process.exitCode = 1;
  });
