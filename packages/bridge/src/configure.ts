import { DEFAULT_HUB, normalizeUser, writeCredentials } from './config';

/**
 * `team-bridge configure --user alice [--hub wss://...] [--create-token ...]`
 * Writes a local credentials.json. Not a login — there are no accounts; this
 * only matters when running the CLI outside Claude or against a self-hosted
 * hub. Inside Claude the name comes from userConfig and the hub is DEFAULT_HUB.
 */
export function runConfigure(args: string[]) {
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hub = get('hub') ?? DEFAULT_HUB;
  const user = get('user');
  const createToken = get('create-token');
  if (!user) {
    console.error('usage: team-bridge configure --user <your name> [--hub wss://...] [--create-token <token>]');
    process.exitCode = 1;
    return;
  }
  writeCredentials({ hub: hub.replace(/^http/, 'ws'), user: normalizeUser(user), ...(createToken ? { createToken } : {}) });
  console.log(`saved local config: user=${normalizeUser(user)} hub=${hub}`);
}
