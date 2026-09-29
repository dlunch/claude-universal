// Bun.spawn and Bun.Terminal on Node. A process spawned with a Terminal runs on a node-pty
// pseudo-terminal; any other process uses child_process.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import pty from 'node-pty';

const BUN_FILE = Symbol('BunFile');

export function file(path) {
  return { [BUN_FILE]: path };
}

function nodeStdio(value) {
  return value?.[BUN_FILE] === undefined ? value : fs.openSync(value[BUN_FILE], 'w');
}

// Bun resolves `exited` with the exit code, or 128 + the signal number.
function subprocess(pid, kill, onExit) {
  const proc = { pid, exitCode: null, signalCode: null, killed: false };
  proc.kill = (signal = 'SIGTERM') => {
    proc.killed = true;
    kill(signal);
  };
  proc.exited = new Promise((resolve) => onExit((code, signal) => {
    proc.exitCode = code;
    proc.signalCode = signal;
    resolve(code ?? 128 + os.constants.signals[signal]);
  }));
  return proc;
}

export function spawn(cmd, options = {}) {
  if (!Array.isArray(cmd)) ({ cmd, ...options } = cmd);
  const [command, ...args] = cmd;
  if (options.terminal) return options.terminal.spawn(command, args, options);
  const stdio = options.stdio ?? [options.stdin ?? 'ignore', options.stdout ?? 'pipe', options.stderr ?? 'inherit'];
  const child = childProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    argv0: options.argv0,
    detached: options.detached,
    stdio: stdio.map(nodeStdio),
  });
  const proc = subprocess(child.pid, (signal) => child.kill(signal), (done) => child.once('exit', done));
  proc.unref = () => child.unref();
  proc.ref = () => child.ref();
  return proc;
}

export class Terminal {
  constructor({ cols, rows, data }) {
    this.cols = cols;
    this.rows = rows;
    this.data = data;
  }

  spawn(command, args, { cwd, env }) {
    this.pty = pty.spawn(command, args, { name: env?.TERM ?? 'xterm-256color', cols: this.cols, rows: this.rows, cwd, env, encoding: null });
    this.pty.onData((chunk) => this.data?.(this, chunk));
    return subprocess(this.pty.pid, (signal) => this.pty.kill(signal), (done) => this.pty.onExit(({ exitCode, signal }) => {
      const name = Object.keys(os.constants.signals).find((key) => os.constants.signals[key] === signal);
      done(name ? null : exitCode, name ?? null);
    }));
  }

  write(data) {
    this.pty.write(data);
  }

  resize(cols, rows) {
    this.pty.resize(cols, rows);
  }

  close() {
    this.pty?.destroy();
  }
}
