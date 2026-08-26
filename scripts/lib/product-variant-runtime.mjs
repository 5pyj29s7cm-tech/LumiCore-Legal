import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const metadataPath = path.join(projectRoot, '.lumi', 'variant.json');

let cachedRuntime = null;

export function productVariantRuntime() {
  if (cachedRuntime) return cachedRuntime;
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const runtime = metadata?.runtime;
  const dataDirectoryName = String(runtime?.dataDirectoryName || '').trim();
  if (
    !dataDirectoryName
    || dataDirectoryName === '.'
    || dataDirectoryName === '..'
    || path.basename(dataDirectoryName) !== dataDirectoryName
  ) {
    throw new Error('Product variant metadata contains an invalid runtime.dataDirectoryName.');
  }
  cachedRuntime = Object.freeze({ ...runtime, dataDirectoryName });
  return cachedRuntime;
}

export function resolveVariantDataRoot(configuredRoot = process.env.LUMI_DATA_DIR, homeDirectory = os.homedir()) {
  const configured = String(configuredRoot || '').trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('LUMI_DATA_DIR must be an absolute path.');
    }
    return path.normalize(configured);
  }
  return path.resolve(homeDirectory, productVariantRuntime().dataDirectoryName);
}
