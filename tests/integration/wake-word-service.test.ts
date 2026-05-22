import { EventEmitter, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WakeWordService } from '@main/services/wake-word-service';

function fakeSpawn(linesToEmit: string[]): {
  spawnImpl: NonNullable<ConstructorParameters<typeof WakeWordService>[0]>['spawnImpl'];
  killed: { v: boolean };
} {
  const killed = { v: false };
  const spawnImpl = ((_path: string, args: string[]) => {
    void args;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (s?: string) => void;
    };
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = () => {
      killed.v = true;
      queueMicrotask(() => proc.emit('exit', 0));
    };
    setImmediate(() => {
      for (const l of linesToEmit) stdout.push(`${l}\n`);
      stdout.push(null);
    });
    return proc;
  }) as unknown as NonNullable<ConstructorParameters<typeof WakeWordService>[0]>['spawnImpl'];
  return { spawnImpl, killed };
}

describe('WakeWordService', () => {
  it('parses ready + wake events from stdout JSON lines', async () => {
    const { spawnImpl } = fakeSpawn([
      JSON.stringify({ event: 'ready', models: ['hey_jarvis'] }),
      JSON.stringify({ event: 'wake', model: 'hey_jarvis', score: 0.81 }),
    ]);
    const svc = new WakeWordService({ spawnImpl, scriptPath: '/tmp/x.py', pythonExe: 'python3' });
    const ready: string[][] = [];
    const wakes: Array<[string, number]> = [];
    svc.on('ready', (m) => ready.push(m));
    svc.on('wake', (m, s) => wakes.push([m, s]));
    svc.start('hey_jarvis');
    await new Promise((r) => setTimeout(r, 20));
    expect(ready[0]).toEqual(['hey_jarvis']);
    expect(wakes[0]).toEqual(['hey_jarvis', 0.81]);
  });

  it('ignores malformed JSON lines silently', async () => {
    const { spawnImpl } = fakeSpawn(['not json', 'still nope', JSON.stringify({ event: 'ready', models: ['x'] })]);
    const svc = new WakeWordService({ spawnImpl, scriptPath: '/tmp/x.py' });
    const ready: string[][] = [];
    svc.on('ready', (m) => ready.push(m));
    svc.start('hey_jarvis');
    await new Promise((r) => setTimeout(r, 20));
    expect(ready[0]).toEqual(['x']);
  });

  it('emits error event on JSON error messages', async () => {
    const { spawnImpl } = fakeSpawn([JSON.stringify({ event: 'error', message: 'no mic' })]);
    const svc = new WakeWordService({ spawnImpl, scriptPath: '/tmp/x.py' });
    const errs: string[] = [];
    svc.on('error', (m) => errs.push(m));
    svc.start('hey_jarvis');
    await new Promise((r) => setTimeout(r, 20));
    expect(errs[0]).toBe('no mic');
  });

  it('stop kills the running process and clears state', async () => {
    const { spawnImpl, killed } = fakeSpawn([]);
    const svc = new WakeWordService({ spawnImpl, scriptPath: '/tmp/x.py' });
    svc.start('hey_jarvis');
    expect(svc.isRunning()).toBe(true);
    svc.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(killed.v).toBe(true);
    expect(svc.isRunning()).toBe(false);
  });

  it('start is a no-op if already running', () => {
    let spawnCalls = 0;
    const { spawnImpl } = fakeSpawn([]);
    const inner = spawnImpl as unknown as (p: string, a: string[], o?: unknown) => unknown;
    const wrapped = ((path: string, args: string[], opts?: unknown) => {
      spawnCalls += 1;
      return inner(path, args, opts);
    }) as unknown as NonNullable<ConstructorParameters<typeof WakeWordService>[0]>['spawnImpl'];
    const svc = new WakeWordService({ spawnImpl: wrapped, scriptPath: '/tmp/x.py' });
    svc.start('hey_jarvis');
    svc.start('hey_jarvis');
    expect(spawnCalls).toBe(1);
  });
});
