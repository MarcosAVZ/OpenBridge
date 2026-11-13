import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeIdeaFile, type IdeaFile } from '../../src/ideas/curation.js';
import { readIdeaFiles, writeIdeaFiles } from '../../src/ideas/curation-files.js';

const file: IdeaFile = {
  repo: 'stripe/stripe-node',
  ideas: [
    {
      key: 'reintentos',
      status: 'APPROVED',
      source: 'HUMAN',
      title: 'Reintentos',
      summary: 'Claves de idempotencia.',
      integrationType: 'REST_API',
      difficulty: 'LOW',
      triggers: [],
      snippet: {
        language: 'typescript',
        code: 'await stripe.charges.create(p, { idempotencyKey });',
      },
      stackCompatibility: ['node'],
      connectsWith: [],
    },
  ],
};

describe('archivos de ideas', () => {
  const dirs: string[] = [];
  const tempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideas-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('escribe un archivo por repo y lo lee de vuelta', async () => {
    const dir = await tempDir();
    await writeIdeaFiles(dir, [file]);

    expect(await readdir(dir)).toEqual(['stripe__stripe-node.yaml']);
    expect(await readIdeaFiles(dir)).toEqual([file]);
  });

  it('un directorio inexistente equivale a sin ideas', async () => {
    const dir = join(await tempDir(), 'no-existe');
    expect(await readIdeaFiles(dir)).toEqual([]);
  });

  it('rechaza un archivo cuyo nombre no coincide con su repo', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'otro__nombre.yaml'), serializeIdeaFile(file));
    await expect(readIdeaFiles(dir)).rejects.toThrow(/stripe__stripe-node\.yaml/);
  });

  it('escribir dos veces produce los mismos bytes', async () => {
    const dir = await tempDir();
    await writeIdeaFiles(dir, [file]);
    const first = serializeIdeaFile(file);
    await writeIdeaFiles(dir, [file]);
    expect(serializeIdeaFile((await readIdeaFiles(dir))[0])).toBe(first);
  });
});
