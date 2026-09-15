import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// WebView2 is Windows-only; skip entirely on other platforms
if (process.platform !== 'win32') {
  console.log('Skipping WebView2 DLL setup (not Windows)');
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');

const releaseDir = path.join(root, 'src-tauri', 'target', 'release');
const dllSrc = path.join(releaseDir, 'WebView2Loader.dll');
const dllResourceDest = path.join(root, 'desktop-resources', 'WebView2Loader.dll');
const nshPath = path.join(root, 'src-tauri', 'includes', 'include-dll.nsh');
// The checked-in installer hook is a build input. Rewriting it here would
// invalidate the source identity already embedded in the backend and client.
if (!existsSync(dllSrc)) {
  throw new Error(`Required WebView2Loader.dll is missing: ${dllSrc}`);
}
await fs.access(nshPath);
await fs.copyFile(dllSrc, dllResourceDest);
console.log('Copied WebView2Loader.dll; retained the reviewed NSIS hook.');

// Step 3: Patch the generated NSIS script to also delete the DLL on uninstall.
const nsiPath = path.join(root, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'installer.nsi');
if (existsSync(nsiPath)) {
  let nsi = await fs.readFile(nsiPath, 'utf-8');
  const delMarker = '  ; Delete external binaries';
  const delLine = `  Delete "$$INSTDIR\\WebView2Loader.dll"`;
  if (nsi.includes(delMarker) && !nsi.includes(delLine)) {
    nsi = nsi.replace(delMarker, `${delLine}\r\n${delMarker}`);
    await fs.writeFile(nsiPath, nsi, 'utf-8');
    console.log('Patched NSIS uninstaller to delete WebView2Loader.dll');
  }
}
