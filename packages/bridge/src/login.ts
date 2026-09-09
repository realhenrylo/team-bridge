import { DEFAULT_HUB, normalizeUser, writeCredentials } from './config';

/**
 * `team-bridge login --user alice [--hub wss://...] [--create-token ...]`
 * Dev / self-hosting only: inside Claude the name comes from userConfig and
 * the hub is DEFAULT_HUB.
 */
export function runLogin(args: string[]) {
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hub = get('hub') ?? DEFAULT_HUB;
  const user = get('user');
  const createToken = get('create-token');
  if (!user) {
    console.error('usage: team-bridge login --user <your name> [--hub wss://...] [--create-token <token>]');
    process.exitCode = 1;
    return;
  }
  writeCredentials({ hub: hub.replace(/^http/, 'ws'), user: normalizeUser(user), ...(createToken ? { createToken } : {}) });
  console.log(`saved credentials for ${user} -> ${hub}`);
}
