import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Execute a bash command asynchronously.
 * @param {string} command
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function bash(command) {
  return new Promise((resolve, reject) => {
    if (typeof command !== 'string' || command.trim().length === 0) {
      return reject(new Error('Invalid command'));
    }

    exec(command, { windowsHide: true, shell: true }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * List directory contents.
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
async function ls(dirPath = '.') {
  try {
    const safePath = path.resolve('.', dirPath);
    const entries = await fs.readdir(safePath, { withFileTypes: true });
    return entries.map(e => (e.isDirectory() ? e.name + '/' : e.name));
  } catch (err) {
    throw new Error(`ls failed: ${err.message}`);
  }
}

export { bash, ls };