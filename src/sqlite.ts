// Node 22.5+ / 24+ ships node:sqlite (experimental flag-free on Node 25).
const moduleName = 'node:sqlite';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite = (globalThis as { process: { getBuiltinModule?: (s: string) => unknown } }).process.getBuiltinModule
  ? ((globalThis as { process: { getBuiltinModule: (s: string) => { DatabaseSync: unknown } } }).process.getBuiltinModule(moduleName))
  : null;

if (!sqlite) {
  throw new Error('node:sqlite is required (use Node.js >= 22.5 with --experimental-sqlite, or Node >= 25)');
}

export const DatabaseSync = sqlite.DatabaseSync as typeof import('node:sqlite').DatabaseSync;
export type DatabaseSyncType = import('node:sqlite').DatabaseSync;
