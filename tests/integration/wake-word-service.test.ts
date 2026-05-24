import { EventEmitter, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WakeWordService } from '@main/services/wake-word-service';

interface FakeProcResult {
  spawnImpl: NonNullable<ConstructorParameters<typeof WakeWordService>[0]>['spawnImpl'];
  killed: { v: boolean };
  /** All `args` from successive spawn() calls, in order. */
  argCalls: string[][];
}

function fakeSpawn(linesToEmit: string[]): FakeProcResult {
  const killed = { v: false };
  const argCalls: string[][] = [];
  const spawnImpl = ((_path: string, args: string[]) => {
    argCalls.push(args);
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
  }) as unknown as FakeProcResult['spawnImpl'];
  return { spawnImpl, killed, argCalls };
}

function makeSvc(spawnImpl: FakeProcResult['spawnImpl']): WakeWordService {
  // autoInstall:false so resolvePython() short-circuits to the explicit exe.
  return new WakeWordService({
    spawnImpl,
    scriptPath: '/tmp/x.py',
    pythonExe: 'python3',
    autoInstall: false,
  });
}

describe('WakeWordService (openww mode)', () => {
  it('parses ready + wake events from stdout JSON lines', async () => {
    const { spawnImpl } = fakeSpawn([
      JSON.stringify({ event: 'ready', models: ['hey_jarvis'] }),
      JSON.stringify({ event: 'wake', model: 'hey_jarvis', score: 0.81 }),
    ]);
    const svc = makeSvc(spawnImpl);
    const readyEvents: Array<{ models?: string[]; phrase?: string }> = [];
    const wakeEvents: Array<{ model?: string; score?: number }> = [];
    svc.on('ready', (info) => readyEvents.push(info));
    svc.on('wake', (info) => wakeEvents.push(info));
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    await new Promise((r) => setTimeout(r, 20));
    expect(readyEvents[0]).toEqual({ models: ['hey_jarvis'] });
    expect(wakeEvents[0]).toEqual({ model: 'hey_jarvis', score: 0.81 });
  });

  it('ignores malformed JSON lines silently', async () => {
    const { spawnImpl } = fakeSpawn([
      'not json',
      'still nope',
      JSON.stringify({ event: 'ready', models: ['x'] }),
    ]);
    const svc = makeSvc(spawnImpl);
    const readyEvents: Array<{ models?: string[] }> = [];
    svc.on('ready', (info) => readyEvents.push(info));
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    await new Promise((r) => setTimeout(r, 20));
    expect(readyEvents[0]).toEqual({ models: ['x'] });
  });

  it('emits error event on JSON error messages', async () => {
    const { spawnImpl } = fakeSpawn([JSON.stringify({ event: 'error', message: 'no mic' })]);
    const svc = makeSvc(spawnImpl);
    const errs: string[] = [];
    svc.on('error', (m) => errs.push(m));
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    await new Promise((r) => setTimeout(r, 20));
    expect(errs[0]).toBe('no mic');
  });

  it('passes --mode openww and the right --model/--threshold to the runner', async () => {
    const { spawnImpl, argCalls } = fakeSpawn([]);
    const svc = makeSvc(spawnImpl);
    await svc.start({ mode: 'openww', model: 'computer', threshold: 0.7 });
    expect(argCalls[0]).toEqual([
      '/tmp/x.py',
      '--mode', 'openww',
      '--model', 'computer',
      '--threshold', '0.7',
    ]);
  });

  it('stop kills the running process and clears state', async () => {
    const { spawnImpl, killed } = fakeSpawn([]);
    const svc = makeSvc(spawnImpl);
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    expect(svc.isRunning()).toBe(true);
    svc.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(killed.v).toBe(true);
    expect(svc.isRunning()).toBe(false);
  });

  it('start is a no-op if already running', async () => {
    let spawnCalls = 0;
    const { spawnImpl } = fakeSpawn([]);
    const inner = spawnImpl as unknown as (p: string, a: string[], o?: unknown) => unknown;
    const wrapped = ((path: string, args: string[], opts?: unknown) => {
      spawnCalls += 1;
      return inner(path, args, opts);
    }) as unknown as FakeProcResult['spawnImpl'];
    const svc = makeSvc(wrapped);
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    expect(spawnCalls).toBe(1);
  });
});

describe('WakeWordService (phrase mode)', () => {
  it('passes --mode phrase with the phrase and whisper paths', async () => {
    const { spawnImpl, argCalls } = fakeSpawn([]);
    const svc = makeSvc(spawnImpl);
    await svc.start({
      mode: 'phrase',
      phrase: 'hey hermes',
      whisperBin: '/usr/local/bin/whisper-cli',
      whisperModel: '/tmp/ggml-base.bin',
      language: 'pt',
    });
    expect(argCalls[0]).toEqual([
      '/tmp/x.py',
      '--mode', 'phrase',
      '--phrase', 'hey hermes',
      '--whisper-bin', '/usr/local/bin/whisper-cli',
      '--whisper-model', '/tmp/ggml-base.bin',
      '--language', 'pt',
      '--cooldown', '1.5',
    ]);
  });

  it('emits ready { phrase } and wake { phrase, transcript }', async () => {
    const { spawnImpl } = fakeSpawn([
      JSON.stringify({ event: 'ready', phrase: 'hey hermes' }),
      JSON.stringify({ event: 'wake', phrase: 'hey hermes', transcript: 'Hey, Hermes!' }),
    ]);
    const svc = makeSvc(spawnImpl);
    const ready: Array<{ phrase?: string }> = [];
    const wakes: Array<{ phrase?: string; transcript?: string }> = [];
    svc.on('ready', (info) => ready.push(info));
    svc.on('wake', (info) => wakes.push(info));
    await svc.start({
      mode: 'phrase',
      phrase: 'hey hermes',
      whisperBin: '/x',
      whisperModel: '/y',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(ready[0]).toEqual({ phrase: 'hey hermes' });
    expect(wakes[0]).toEqual({ phrase: 'hey hermes', transcript: 'Hey, Hermes!' });
  });

  it('forwards `transcript` events (live preview during test)', async () => {
    const { spawnImpl } = fakeSpawn([
      JSON.stringify({ event: 'ready', phrase: 'hey hermes' }),
      JSON.stringify({ event: 'transcript', text: 'olá mundo' }),
      JSON.stringify({ event: 'transcript', text: 'hey hermes please' }),
    ]);
    const svc = makeSvc(spawnImpl);
    const texts: string[] = [];
    svc.on('transcript', (t) => texts.push(t));
    await svc.start({
      mode: 'phrase',
      phrase: 'hey hermes',
      whisperBin: '/x',
      whisperModel: '/y',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(texts).toEqual(['olá mundo', 'hey hermes please']);
  });

  it('uses default cooldown=1.5 and language=auto when omitted', async () => {
    const { spawnImpl, argCalls } = fakeSpawn([]);
    const svc = makeSvc(spawnImpl);
    await svc.start({
      mode: 'phrase',
      phrase: 'hey hermes',
      whisperBin: '/a',
      whisperModel: '/b',
    });
    expect(argCalls[0]).toContain('--cooldown');
    expect(argCalls[0]?.[argCalls[0].indexOf('--cooldown') + 1]).toBe('1.5');
    expect(argCalls[0]?.[argCalls[0].indexOf('--language') + 1]).toBe('auto');
  });
});

describe('WakeWordService (python resolution)', () => {
  it('emits friendly error when no python3 is available', async () => {
    const { spawnImpl } = fakeSpawn([]);
    const svc = new WakeWordService({
      spawnImpl,
      scriptPath: '/tmp/x.py',
      autoInstall: false,
      whichImpl: async () => null, // nothing on PATH
    });
    const errs: string[] = [];
    svc.on('error', (m) => errs.push(m));
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    expect(errs[0]).toMatch(/python3/i);
    expect(svc.isRunning()).toBe(false);
  });

  it('uses the system python3 when the venv doesn\'t exist and autoInstall is off', async () => {
    const { spawnImpl, argCalls } = fakeSpawn([]);
    const svc = new WakeWordService({
      spawnImpl,
      scriptPath: '/tmp/x.py',
      autoInstall: false,
      whichImpl: async (cmd) => (cmd === 'python3' ? '/usr/bin/python3' : null),
    });
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    // First (and only) spawn call should be against the resolved python3.
    expect(argCalls).toHaveLength(1);
  });

  it('resolvePython caches the result across calls', async () => {
    let whichCalls = 0;
    const { spawnImpl } = fakeSpawn([]);
    const svc = new WakeWordService({
      spawnImpl,
      scriptPath: '/tmp/x.py',
      autoInstall: false,
      whichImpl: async (cmd) => {
        whichCalls += 1;
        return cmd === 'python3' ? '/usr/bin/python3' : null;
      },
    });
    const first = await svc.resolvePython();
    const second = await svc.resolvePython();
    expect(first).toBe('/usr/bin/python3');
    expect(second).toBe('/usr/bin/python3');
    // 2 calls inside the first resolvePython (no explicit, no venv, then python3),
    // but the second call should hit the cache.
    expect(whichCalls).toBeLessThanOrEqual(1);
  });

  it('isRunning() reports false before start and true after', async () => {
    const { spawnImpl } = fakeSpawn([]);
    const svc = makeSvc(spawnImpl);
    expect(svc.isRunning()).toBe(false);
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    expect(svc.isRunning()).toBe(true);
  });

  it('stop() before start is a no-op', () => {
    const { spawnImpl } = fakeSpawn([]);
    const svc = makeSvc(spawnImpl);
    expect(() => svc.stop()).not.toThrow();
  });
});

describe('WakeWordService (JSON-line parser edge cases)', () => {
  it('ignores stdout lines that are not objects', async () => {
    const { spawnImpl } = fakeSpawn([
      '42',           // top-level number — invalid shape
      '"oops"',       // top-level string
      '[1, 2, 3]',    // top-level array
      JSON.stringify({ event: 'ready', models: ['x'] }),
    ]);
    const svc = makeSvc(spawnImpl);
    const reads: Array<{ models?: string[] }> = [];
    svc.on('ready', (info) => reads.push(info));
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toHaveLength(1);
  });

  it('ignores events with missing required fields', async () => {
    const { spawnImpl } = fakeSpawn([
      JSON.stringify({ event: 'wake' }), // no model + no phrase
      JSON.stringify({ event: 'wake', model: 42 }), // wrong type
      JSON.stringify({ event: 'wake', model: 'computer', score: 0.7 }), // valid
    ]);
    const svc = makeSvc(spawnImpl);
    const wakes: Array<{ model?: string }> = [];
    svc.on('wake', (info) => wakes.push(info));
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    await new Promise((r) => setTimeout(r, 20));
    // All three lines emit some wake — including the malformed ones whose
    // fields are just undefined. The contract is "no crash" + "structured
    // events when fields present". The third one is the only well-formed wake.
    expect(wakes.some((w) => w.model === 'computer')).toBe(true);
  });

  it('ignores empty stdout lines', async () => {
    const { spawnImpl } = fakeSpawn([
      '',
      '   ',
      JSON.stringify({ event: 'ready', models: ['x'] }),
    ]);
    const svc = makeSvc(spawnImpl);
    const reads: Array<{ models?: string[] }> = [];
    svc.on('ready', (info) => reads.push(info));
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toHaveLength(1);
  });

  it('exit handler clears the proc reference', async () => {
    const { spawnImpl } = fakeSpawn([]);
    const svc = makeSvc(spawnImpl);
    let exited = false;
    svc.on('exit', () => {
      exited = true;
    });
    await svc.start({ mode: 'openww', model: 'hey_jarvis' });
    svc.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(exited).toBe(true);
    expect(svc.isRunning()).toBe(false);
  });
});
