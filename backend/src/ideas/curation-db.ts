import { isDeepStrictEqual } from 'node:util';
import { asc, eq, exists, and } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { integrationIdea, repository } from '../db/schema.js';
import { assignKeys, fileIdeaSchema, type FileIdea, type IdeaFile } from './curation.js';
import { newIntegrationIdeaSchema } from './schema.js';

// Meta de OB-19: al menos 90 % de los repos con una idea aprobada.
export const COVERAGE_GOAL_PERCENT = 90;

type IdeaStatus = FileIdea['status'];

export interface ApplyReport {
  inserted: number;
  updated: number;
  unchanged: number;
  statusCounts: Record<IdeaStatus, number>;
  unknownRepos: string[];
  skipped: { repo: string; key: string; reason: string }[];
  coverage: { withApproved: number; total: number; percent: number; goal: number };
}

type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const sorted = (values: string[]) => [...values].sort();

// Vuelca las ideas de la base con la forma del archivo. No modifica la base:
// la clave de las ideas que todavía no tienen se deriva del título, igual que
// lo hace `apply` al adoptarlas.
export async function exportIdeas(db: Db): Promise<IdeaFile[]> {
  const repositories = await db
    .select({ id: repository.id, fullName: repository.fullName })
    .from(repository);
  const names = new Map(repositories.map((r) => [r.id, r.fullName]));

  const rows = await db
    .select({ idea: integrationIdea, repo: repository.fullName })
    .from(integrationIdea)
    .innerJoin(repository, eq(repository.id, integrationIdea.repositoryId))
    .orderBy(asc(repository.fullName), asc(integrationIdea.createdAt), asc(integrationIdea.id));

  const groups = new Map<string, (typeof rows)[number]['idea'][]>();
  for (const { idea, repo } of rows) {
    const group = groups.get(repo);
    if (group) group.push(idea);
    else groups.set(repo, [idea]);
  }

  return [...groups].map(([repo, ideas]) => {
    const keys = assignKeys(ideas);
    return {
      repo,
      ideas: ideas
        .map((idea): FileIdea => ({
          key: keys.get(idea.id) ?? idea.id,
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
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    };
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
// resuelve se informan y se saltean.
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
    const repositories = await tx
      .select({ id: repository.id, fullName: repository.fullName })
      .from(repository);
    const repoIds = new Map(repositories.map((r) => [r.fullName, r.id]));

    const report: ApplyReport = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      statusCounts: { DRAFT: 0, APPROVED: 0, REJECTED: 0 },
      unknownRepos: [],
      skipped: [],
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
      const keys = assignKeys(existing);
      const byKey = new Map(existing.map((row) => [keys.get(row.id), row]));

      for (const idea of ideas) {
        const unresolved = idea.connectsWith.filter((name) => !repoIds.has(name));
        if (unresolved.length > 0) {
          report.skipped.push({
            repo,
            key: idea.key,
            reason: `connectsWith apunta a repos que no están en la base: ${unresolved.join(', ')}`,
          });
          continue;
        }
        report.statusCounts[idea.status] += 1;

        const content = newIntegrationIdeaSchema.parse({
          repositoryId,
          title: idea.title,
          summary: idea.summary,
          integrationType: idea.integrationType,
          triggers: idea.triggers,
          snippet: idea.snippet,
          stackCompatibility: idea.stackCompatibility,
          difficulty: idea.difficulty,
          connectsWith: sorted(idea.connectsWith.map((name) => repoIds.get(name) ?? '')),
          source: idea.source,
        });

        const row = byKey.get(idea.key);
        if (!row) {
          await tx
            .insert(integrationIdea)
            .values({ ...content, key: idea.key, status: idea.status });
          report.inserted += 1;
          continue;
        }

        const contentChanged =
          row.title !== content.title ||
          row.summary !== content.summary ||
          row.integrationType !== content.integrationType ||
          row.difficulty !== content.difficulty ||
          !isDeepStrictEqual(row.triggers, content.triggers) ||
          !isDeepStrictEqual(row.snippet, content.snippet) ||
          !isDeepStrictEqual(row.stackCompatibility, content.stackCompatibility) ||
          !isDeepStrictEqual(sorted(row.connectsWith), content.connectsWith);
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
