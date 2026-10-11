const t0 = Date.now();
const stamp = () => {
  const d = new Date();
  return d.toISOString().slice(11, 23);
};
export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};
export function createLogger(prefix = 'provider'): Logger {
  const debugOn = process.env.PROVIDER_DEBUG === '1';
  const line = (lvl: string, msg: string) => `${stamp()} [${prefix}] ${lvl}${msg}`;
  return {
    info: (m) => console.log(line('', m)),
    warn: (m) => console.warn(line('\x1b[33mwarn\x1b[0m ', m)),
    error: (m) => console.error(line('\x1b[31merror\x1b[0m ', m)),
    debug: (m) => {
      if (debugOn) console.log(line('\x1b[90mdebug\x1b[0m ', m));
    },
  };
}
export const uptimeMs = () => Date.now() - t0;
