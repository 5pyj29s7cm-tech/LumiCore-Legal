import path from 'node:path';

/** File identity follows the filesystem platform, never natural-language folding. */
export function fileNameIdentity(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

export function normalizePathIdentity(value: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return fileNameIdentity(paths.normalize(value), platform);
}

export function isPathInsideRoot(filePath: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const separator = platform === 'win32' ? '\\' : '/';
  const file = normalizePathIdentity(filePath, platform);
  const directory = normalizePathIdentity(root, platform);
  return file === directory || file.startsWith(directory.endsWith(separator) ? directory : directory + separator);
}

/** A single filename policy for legal workspace directories and document names. */
export function safeFileSegment(input: string, fallback = 'material'): string {
  const cleaned = String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 90);
  return cleaned || fallback;
}
