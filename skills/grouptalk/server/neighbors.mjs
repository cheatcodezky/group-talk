import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAC = /\b(?:[\da-f]{1,2}[:-]){5}[\da-f]{1,2}\b/i;

export function clientAddress(remoteAddress = '') {
  const mapped = remoteAddress.slice(7);
  if (remoteAddress.startsWith('::ffff:') && isIP(mapped) === 4) return mapped;
  return isIP(remoteAddress) ? remoteAddress : null;
}

function normalizeMac(address = '') {
  const value = address.match(MAC)?.[0].toLowerCase().split(/[:-]/).map((part) => part.padStart(2, '0')).join(':');
  if (!value || value === '00:00:00:00:00:00' || (parseInt(value.slice(0, 2), 16) & 1)) return null;
  return value;
}

export function macFromNeighbors(output, ip) {
  const addresses = new Set(output.split(/\r?\n/)
    .filter((line) => line.split(/[()\s]+/).includes(ip))
    .map(normalizeMac).filter(Boolean));
  return addresses.size === 1 ? addresses.values().next().value : null;
}

export async function lookupClientMac(ip) {
  if (isIP(ip) !== 4 || ip.startsWith('127.')) return null;
  const local = Object.values(networkInterfaces()).flat().find((entry) => entry?.address === ip);
  if (local) return normalizeMac(local.mac);
  let command;
  if (process.platform === 'darwin') command = ['/usr/sbin/arp', '-n', ip];
  if (process.platform === 'win32') command = [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'arp.exe'), '-a', ip];
  if (process.platform === 'linux') {
    const file = ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'].find(existsSync);
    if (file) command = [file, 'neigh', 'show', 'to', ip];
  }
  if (!command) return null;
  try {
    const [file, ...args] = command;
    const { stdout } = await run(file, args, { timeout: 1000, maxBuffer: 16_384, windowsHide: true });
    return macFromNeighbors(stdout, ip);
  } catch { return null; }
}
