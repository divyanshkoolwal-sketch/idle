import os from 'node:os';
import { execFile } from 'node:child_process';
import type { Hardware } from './types';

function macChipName(timeoutMs = 4000): Promise<string | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = execFile('system_profiler', ['SPHardwareDataType'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = stdout.match(/(?:Chip|Processor Name):\s*(.+)/);
      resolve(m ? m[1].trim() : undefined);
    });
    child.on('error', () => resolve(undefined));
  });
}

export async function detectHardware(): Promise<Hardware> {
  const cpu = os.cpus()[0]?.model?.trim() || 'unknown cpu';
  const ramGb = Math.round(os.totalmem() / 2 ** 30);
  const chip = await macChipName();
  const label = `${chip ?? cpu} · ${ramGb} GB`;
  return { cpu, chip, ramGb, label };
}
