import { execFile } from 'node:child_process';

/** Best-effort desktop notification; used to wake a human whose session is idle. */
export function notifyDesktop(title: string, body: string) {
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&').slice(0, 200);
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
  } else if (process.platform === 'linux') {
    execFile('notify-send', [title, body], () => {});
  }
}
