import { normalizeUser, writeCredentials } from './config';

/**
 * `team-bridge login --hub wss://... --user alice [--create-token ...]`
 * Dev-only: inside Claude these values come from the plugin's userConfig.
 */
export function runLogin(args: string[]) {
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hub = get('hub');
  const user = get('user');
  const createToken = get('create-token');
  if (!hub || !user) {
    console.error('usage: team-bridge login --hub wss://<worker>.workers.dev --user <your name> [--create-token <token>]');
    process.exitCode = 1;
    return;
  }
  writeCredentials({ hub: hub.replace(/^http/, 'ws'), user: normalizeUser(user), ...(createToken ? { createToken } : {}) });
  console.log(`saved credentials for ${user} -> ${hub}`);
}
