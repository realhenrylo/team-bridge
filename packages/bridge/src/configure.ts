import { DEFAULT_HUB, normalizeUser, writeCredentials } from './config';

/**
 * `agent-room configure --user alice [--hub wss://...]`
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
  if (!user) {
    console.error('usage: agent-room configure --user <your name> [--hub wss://...]');
    process.exitCode = 1;
    return;
  }
  writeCredentials({ hub: hub.replace(/^http/, 'ws'), user: normalizeUser(user) });
  console.log(`saved local config: user=${normalizeUser(user)} hub=${hub}`);
}
