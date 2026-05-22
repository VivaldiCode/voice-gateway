/**
 * Cross-service subprocess helpers — kept in a separate module so the STT and
 * TTS adapters don't need to import each other.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import log from 'electron-log/main';

export interface ProgressLike {
  stage: 'downloading' | 'extracting' | 'verifying' | 'installing' | 'ready';
  fraction: number | null;
  detail?: string;
}

/** Spawn `which` (or `where` on Windows) and return the first hit, or null. */
export function whichCmd(cmd: string): Promise<string | null> {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(tool, [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (b: Buffer) => chunks.push(b));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const first = Buffer.concat(chunks).toString('utf-8').split(/\r?\n/)[0]?.trim();
      resolve(first && first.length > 0 ? first : null);
    });
  });
}

/** Stream-download a URL to `dest`, reporting progress as fractions of the
 *  content-length header (null when the server doesn't report one). */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (p: ProgressLike) => void,
): Promise<void> {
  log.info('[VG] downloading', url, '→', dest);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length') ?? '0') || null;
  const reader = res.body.getReader();
  const stream = createWriteStream(dest);
  let downloaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stream.write(value);
      downloaded += value.length;
      onProgress?.({
        stage: 'downloading',
        fraction: total ? downloaded / total : null,
        detail: `${(downloaded / 1024 / 1024).toFixed(1)} MB`,
      });
    }
  } finally {
    stream.end();
  }
  await new Promise<void>((resolve) => stream.on('finish', () => resolve()));
}
