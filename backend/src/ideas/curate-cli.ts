import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb } from '../db/client.js';
import { formatEmbeddingReport, generateEmbeddings } from '../ingest/embeddings.js';
import { parseInitialInventory } from '../ingest/initial-load.js';
import { reviewIdeas } from './curation.js';
import { applyIdeaFiles, exportIdeas, type ApplyReport } from './curation-db.js';
import { readIdeaFiles, writeIdeaFiles } from './curation-files.js';

// npm run db:ideas -- <export|apply|review> [--dir seed/ideas] [--embed]
//   export  vuelca las ideas de la base a seed/ideas/ (un archivo por repo)
//   apply   valida seed/ideas/ y lo aplica a la base (idempotente)
//           --embed genera los vectores de las ideas aprobadas (necesita Ollama)
//   review  chequeos objetivos sobre las ideas en DRAFT; no modifica nada

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: 'string' }, embed: { type: 'boolean', default: false } },
});
const [command] = positionals;
const dir = resolve(values.dir ?? resolve(repositoryRoot, 'seed/ideas'));

function formatApplyReport(report: ApplyReport): string {
  const { statusCounts: s, coverage: c } = report;
  const lines = [
    `Ideas: ${report.inserted} insertadas, ${report.updated} actualizadas, ${report.unchanged} sin cambios.`,
    `Estados en los archivos: ${s.APPROVED} APPROVED, ${s.REJECTED} REJECTED, ${s.DRAFT} DRAFT.`,
    `Repos con al menos una idea aprobada: ${c.withApproved}/${c.total} (${c.percent} %), meta ${c.goal} %` +
      (c.percent >= c.goal ? ': cumplida.' : ': todavía no se alcanza.'),
  ];
  for (const repo of report.unknownRepos) lines.push(`  ! Repo desconocido (se omitió): ${repo}`);
  for (const { repo, key, reason } of report.skipped) {
    lines.push(`  ! Idea omitida ${repo} / ${key}: ${reason}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (command !== 'export' && command !== 'apply' && command !== 'review') {
    throw new Error('Uso: npm run db:ideas -- <export|apply|review> [--dir ruta] [--embed]');
  }

  if (command === 'review') {
    const files = await readIdeaFiles(dir);
    const inventory = parseInitialInventory(
      await readFile(resolve(repositoryRoot, 'seed/repos.yaml'), 'utf8'),
    );
    const known = new Set([
      ...inventory.map(({ owner, name }) => `${owner}/${name}`),
      ...files.map((f) => f.repo),
    ]);
    const drafts = files.flatMap((f) => f.ideas).filter((i) => i.status === 'DRAFT').length;
    const flagged = reviewIdeas(files, known);
    console.log(`Ideas en DRAFT: ${drafts}; con alertas: ${flagged.length}.`);
    for (const { repo, key, title, flags } of flagged) {
      console.log(`\n${repo} / ${key}  (${title})`);
      for (const { code, detail } of flags) console.log(`  - ${code}: ${detail}`);
    }
    console.log(
      '\nEsto no aprueba nada: cambiá "status" en el archivo (APPROVED o REJECTED) y subí el PR.',
    );
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('Falta DATABASE_URL: copiá backend/.env.example a backend/.env');
  const { db, pool } = createDb(databaseUrl);
  try {
    if (command === 'export') {
      const files = await exportIdeas(db);
      await writeIdeaFiles(dir, files);
      const total = files.reduce((sum, f) => sum + f.ideas.length, 0);
      console.log(`Exportadas ${total} ideas de ${files.length} repos a ${dir}`);
      return;
    }

    const report = await applyIdeaFiles(db, await readIdeaFiles(dir));
    console.log(formatApplyReport(report));
    if (values.embed) {
      const embeddings = await generateEmbeddings(db);
      console.log(formatEmbeddingReport(embeddings));
      if (embeddings.failed.length > 0) process.exitCode = 1;
    } else {
      console.log('Sin vectores nuevos: corré con --embed, db:embed o esperá la próxima db:sync.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Falló la curaduría de ideas:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
