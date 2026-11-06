/**
 * Security rule (PHASE 02 §4): this package never holds keys, signs or broadcasts.
 * Fails if any signing/broadcast identifier appears in package source code. Comments are
 * allowed (documentation explains the design); code is not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  'privateKey',
  'privateKeyToAccount',
  'mnemonicToAccount',
  'signTransaction',
  'sendTransaction',
  'sendRawTransaction',
  'signTypedData',
  'signMessage',
  'createWalletClient',
  'eth_sendRawTransaction',
  'eth_sendTransaction',
];

const root = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sourceFiles(path);
    return /\.(ts|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

/** Strip // and /* *\/ comments (good enough for our own sources; strings stay). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('no signing or broadcasting code', () => {
  const files = [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'scripts'))];

  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(FORBIDDEN)('source contains no "%s"', (word) => {
    const offenders = files.filter((f) => stripComments(readFileSync(f, 'utf8')).includes(word));
    expect(offenders).toEqual([]);
  });

  it('the generated OpenAPI types file only contains types', () => {
    const generated = readFileSync(join(root, 'src', 'generated', 'trading-api.ts'), 'utf8');
    const code = stripComments(generated);
    expect(code).not.toMatch(/\bfunction\b|=>\s*{|\bnew\s+\w+\(/);
  });

  it('declares no wallet/signing dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const dep of Object.keys(pkg.dependencies)) {
      expect(dep).not.toMatch(/wallet|signer|ethers|@privy|keystore/i);
    }
  });
});
