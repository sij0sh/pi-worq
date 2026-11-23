import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const windows = process.platform === "win32";
export const controlExtension = windows ? ".json" : ".sock";

export function statePath() {
  const base = windows ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : process.env.XDG_STATE_HOME || join(homedir(), ".local/state");
  return resolve(process.env.WORQ_STATE_DIR || join(base, "pi-worq"));
}

/** @param {string} id */
export function controlPipe(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid Worq pipe ID");
  return `\\\\.\\pipe\\pi-worq-${id}`;
}
