import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_FILE = path.join(os.homedir(), '.task-manager', 'config.json');

const DEFAULTS = {
  maxConcurrency: 3,
  agentCommand: 'claude',
  agentCommandArgs: [],
};

export function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}
