import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, exists } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { integrationIdea, repository } from '../db/schema.js';
import { generateEmbeddings, type EmbeddingReport } from '../ingest/embeddings.js';
import { fileIdeaSchema, resolveKeys, slugify, type FileIdea, type IdeaFile } from './curation.js';
import { newIntegrationIdeaSchema } from './schema.js';

// Meta de OB-19: al menos 90 % de los repos con una idea aprobada.
export const COVERAGE_GOAL_PERCENT = 90;

type IdeaStatus = FileIdea['status'];
type IdeaRow = typeof integrationIdea.$inferSelect;

export interface ApplyReport {
  inserted: number;
  updated: number;
  unchanged: number;
  statusCounts: Record<IdeaStatus, number>;
  unknownRepos: string[];
  skipped: { repo: string; key: string; reason: string }[];
  // Ideas de la base que no están en el archivo de su repo. No se borran:
  // una idea se retira con status REJECTED.
  missing: { repo: string; key: string }[];
  // Ideas nuevas del archivo cuya clave coincide con la de una idea sin clave
  // de la base que tiene otro contenido: se insertaron como ideas distintas.
  collisions: { repo: string; key: string }[];
  coverage: { withApproved: number; total: number; percent: number; goal: number };
}

type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const sorted = (values: string[]) => [...values].sort();
const byKeyOrder = (a: FileIdea, b: FileIdea) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

async function loadRepoIds(db: Executor): Promise<Map<string, string>> {
  const repositories = await db
    .select({ id: repository.id, fullName: repository.fullName })
    .from(repository);
  return new Map(repositories.map((r) => [r.fullName, r.id]));
}

// Contenido de la idea del archivo tal como se guarda (connectsWith por id),
// o null si apunta a un repo que no está en la base.
function contentFromFile(idea: FileIdea, repoIds: Map<string, string>) {
  const connectsWith = idea.connectsWith.map((name) => repoIds.get(name));
  if (connectsWith.some((id) => id === undefined)) return null;
  return {
    title: idea.title,
    summary: idea.summary,
    integrationType: idea.integrationType,
    difficulty: idea.difficulty,
    triggers: idea.triggers,
    snippet: idea.snippet,
    stackCompatibility: idea.stackCompatibility,
    connectsWith: sorted(connectsWith as string[]),
  };
}

// Compara contenido (no estado ni fuente). Los ids de connectsWith que ya no
// son repos de la base se ignoran: export los descarta y no son un cambio.
function sameContent(
  row: IdeaRow,
  content: NonNullable<ReturnType<typeof contentFromFile>>,
  validIds: Set<string>,
): boolean {
  return (
    row.title === content.title &&
    row.summary === content.summary &&
    row.integrationType === content.integrationType &&
    row.difficulty === content.difficulty &&
    isDeepStrictEqual(row.triggers, content.triggers) &&
    isDeepStrictEqual(row.snippet, content.snippet) &&
    isDeepStrictEqual(row.stackCompatibility, content.stackCompatibility) &&
    isDeepStrictEqual(
      sorted(row.connectsWith.filter((id) => validIds.has(id))),
      content.connectsWith,
    )
  );
}

function keyResolver(
  rows: IdeaRow[],
  fileIdeas: FileIdea[],
  repoIds: Map<string, string>,
  validIds: Set<string>,
) {
  const fileByKey = new Map(fileIdeas.map((idea) => [idea.key, idea]));
  return resolveKeys(rows, fileIdeas, (row, key) => {
    const idea = fileByKey.get(key);
    const content = idea && contentFromFile(idea, repoIds);
    return content ? sameContent(row, content, validIds) : false;
  });
}

// Vuelca las ideas de la base con la forma del archivo, sin modificar la
// base. Si ya hay archivos, los fusiona: lo que está en el archivo (estado,
// fuente y contenido) manda y solo se agregan las ideas de la base cuya clave
// no está. Así una base desactualizada no revierte lo revisado en un PR.
// Devuelve solo los repos que tienen ideas en la base.
export async function exportIdeas(db: Db, existing: IdeaFile[] = []): Promise<IdeaFile[]> {
  const repoIds = await loadRepoIds(db);
  const validIds = new Set(repoIds.values());
  const names = new Map([...repoIds].map(([name, id]) => [id, name]));
  const fileByRepo = new Map(existing.map((file) => [file.repo, file]));

  const rows = await db
    .select({ idea: integrationIdea, repo: repository.fullName })
    .from(integrationIdea)
    .innerJoin(repository, eq(repository.id, integrationIdea.repositoryId))
    .orderBy(asc(repository.fullName), asc(integrationIdea.createdAt), asc(integrationIdea.id));

  const groups = new Map<string, IdeaRow[]>();
  for (const { idea, repo } of rows) {
    const group = groups.get(repo);
    if (group) group.push(idea);
    else groups.set(repo, [idea]);
  }

  return [...groups].map(([repo, ideas]) => {
    const fileIdeas = fileByRepo.get(repo)?.ideas ?? [];
    const keys = keyResolver(ideas, fileIdeas, repoIds, validIds);
    const inFile = new Set(fileIdeas.map((i) => i.key));
    const added = ideas.flatMap((idea): FileIdea[] => {
      const key = keys.get(idea.id) ?? idea.id;
      if (inFile.has(key)) return [];
      return [
        {
          key,
          status: idea.status,
          source: idea.source,
          title: idea.title,
          summary: idea.summary,
          integrationType: idea.integrationType,
          difficulty: idea.difficulty,
          triggers: idea.triggers,
          snippet: idea.snippet,
          stackCompatibility: idea.stackCompatibility,
          connectsWith: sorted(
            idea.connectsWith.flatMap((id) => {
              const name = names.get(id);
              return name ? [name] : [];
            }),
          ),
        },
      ];
    });
    return { repo, ideas: [...fileIdeas, ...added].sort(byKeyOrder) };
  });
}

async function approvedCoverage(db: Executor): Promise<ApplyReport['coverage']> {
  const repos = await db.select({ id: repository.id }).from(repository);
  const withIdeas = await db
    .select({ id: repository.id })
    .from(repository)
    .where(
      exists(
        db
          .select({ id: integrationIdea.id })
          .from(integrationIdea)
          .where(
            and(
              eq(integrationIdea.repositoryId, repository.id),
              eq(integrationIdea.status, 'APPROVED'),
            ),
          ),
      ),
    );
  const total = repos.length;
  const percent = total === 0 ? 0 : Math.round((withIdeas.length / total) * 1000) / 10;
  return { withApproved: withIdeas.length, total, percent, goal: COVERAGE_GOAL_PERCENT };
}

// Aplica los archivos a la base, idempotente. Toda la corrida es una
// transacción: si algo falla no queda nada a medias. Una idea inválida corta
// antes de tocar la base; un repo desconocido o un connectsWith que no se
// resuelve se informan y se saltean. Nunca borra: las ideas de la base que
// faltan en el archivo se informan en `missing`.
//
// Fuente: si el contenido del archivo difiere del que hay en la base y la
// idea era del modelo, la corrigió una persona y pasa a HUMAN. HUMAN no vuelve
// a LLM.
export async function applyIdeaFiles(db: Db, files: IdeaFile[]): Promise<ApplyReport> {
  for (const { repo, ideas } of files) {
    for (const idea of ideas) {
      const result = fileIdeaSchema.safeParse(idea);
      if (!result.success) {
        const details = result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        throw new Error(`Idea inválida en ${repo} (${idea.key}): ${details}`);
      }
    }
  }

  return db.transaction(async (tx) => {
    const repoIds = await loadRepoIds(tx);
    const validIds = new Set(repoIds.values());

    const report: ApplyReport = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      statusCounts: { DRAFT: 0, APPROVED: 0, REJECTED: 0 },
      unknownRepos: [],
      skipped: [],
      missing: [],
      collisions: [],
      coverage: { withApproved: 0, total: 0, percent: 0, goal: COVERAGE_GOAL_PERCENT },
    };

    for (const { repo, ideas } of files) {
      const repositoryId = repoIds.get(repo);
      if (!repositoryId) {
        report.unknownRepos.push(repo);
        continue;
      }

      const existing = await tx
        .select()
        .from(integrationIdea)
        .where(eq(integrationIdea.repositoryId, repositoryId))
        .orderBy(asc(integrationIdea.createdAt), asc(integrationIdea.id));
      const keys = keyResolver(existing, ideas, repoIds, validIds);
      const byKey = new Map(existing.map((row) => [keys.get(row.id), row]));
      const inFile = new Set(ideas.map((i) => i.key));
      for (const row of existing) {
        const key = keys.get(row.id) ?? row.id;
        if (!inFile.has(key)) report.missing.push({ repo, key });
      }

      for (const idea of ideas) {
        const resolved = contentFromFile(idea, repoIds);
        if (!resolved) {
          const unresolved = idea.connectsWith.filter((name) => !repoIds.has(name));
          report.skipped.push({
            repo,
            key: idea.key,
            reason: `connectsWith apunta a repos que no están en la base: ${unresolved.join(', ')}`,
          });
          continue;
        }
        report.statusCounts[idea.status] += 1;

        const content = newIntegrationIdeaSchema.parse({
          ...resolved,
          repositoryId,
          source: idea.source,
        });

        const row = byKey.get(idea.key);
        if (!row) {
          await tx
            .insert(integrationIdea)
            .values({ ...content, key: idea.key, status: idea.status });
          report.inserted += 1;
          if (existing.some((r) => !r.key && slugify(r.title) === idea.key)) {
            report.collisions.push({ repo, key: idea.key });
          }
          continue;
        }

        const contentChanged = !sameContent(row, resolved, validIds);
        const source =
          row.source === 'HUMAN' || idea.source === 'HUMAN' || contentChanged ? 'HUMAN' : 'LLM';

        if (!contentChanged && row.status === idea.status && row.source === source && row.key) {
          report.unchanged += 1;
          continue;
        }
        await tx
          .update(integrationIdea)
          .set({
            ...(contentChanged ? content : {}),
            key: idea.key,
            status: idea.status,
            source,
            updatedAt: new Date(),
          })
          .where(eq(integrationIdea.id, row.id));
        report.updated += 1;
      }
    }

    report.coverage = await approvedCoverage(tx);
    return report;
  });
}

export interface ApplyCurationOptions {
  embed?: boolean;
  generate?: (db: Db) => Promise<EmbeddingReport>;
}

// `apply` más, solo con embed, la generación de vectores de las ideas
// aprobadas (necesita Ollama).
export async function applyCuration(
  db: Db,
  files: IdeaFile[],
  { embed = false, generate = generateEmbeddings }: ApplyCurationOptions = {},
): Promise<{ report: ApplyReport; embeddings: EmbeddingReport | null }> {
  const report = await applyIdeaFiles(db, files);
  return { report, embeddings: embed ? await generate(db) : null };
}
