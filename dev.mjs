import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
const children = [
  spawn(process.execPath, ['--watch', resolve(root, 'server.mjs')], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [viteBin, '--configLoader', 'runner', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' }),
];
let shuttingDown = false;

const stop = (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  children.forEach(child => { if (!child.killed) child.kill(); });
  process.exitCode = exitCode;
};

children.forEach(child => child.once('error', () => stop(1)));
children.forEach(child => child.once('exit', (code, signal) => {
  if (shuttingDown) return;
  const failed = signal || (code !== null && code !== 0);
  stop(failed ? 1 : 0);
}));
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
