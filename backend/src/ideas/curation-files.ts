import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ideaFileName, parseIdeaFile, serializeIdeaFile, type IdeaFile } from './curation.js';

// Lee todos los .yaml del directorio, en orden de nombre. Un directorio que
// todavía no existe equivale a "sin ideas versionadas".
export async function readIdeaFiles(dir: string): Promise<IdeaFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.yaml')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files: IdeaFile[] = [];
  for (const name of names) {
    const file = parseIdeaFile(await readFile(join(dir, name), 'utf8'));
    if (ideaFileName(file.repo) !== name) {
      throw new Error(
        `${name} contiene ideas de ${file.repo}: el archivo debería llamarse ${ideaFileName(file.repo)}`,
      );
    }
    files.push(file);
  }
  return files;
}

export async function writeIdeaFiles(dir: string, files: IdeaFile[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    await writeFile(join(dir, ideaFileName(file.repo)), serializeIdeaFile(file), 'utf8');
  }
}
