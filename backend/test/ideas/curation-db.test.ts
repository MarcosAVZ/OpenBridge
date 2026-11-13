import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntegrationIdea } from '../../src/db/integration-ideas.js';
import { integrationIdea, repository } from '../../src/db/schema.js';
import { applyCuration, applyIdeaFiles, exportIdeas } from '../../src/ideas/curation-db.js';
import type { FileIdea, IdeaFile } from '../../src/ideas/curation.js';
import { createTestDb, type TestDb } from '../helpers/test-db.js';

const REPO = 'stripe/stripe-node';
const OTHER = 'supabase/supabase';
const THIRD = 'vercel/next.js';

describe('curaduría de ideas contra la base', () => {
  let t: TestDb;
  let githubId = 0;
  const ids: Record<string, string> = {};

  async function addRepo(db: TestDb['db'], fullName: string) {
    githubId += 1;
    const [saved] = await db
      .insert(repository)
      .values({
        githubId,
        fullName,
        name: fullName.split('/')[1],
        url: `https://github.com/${fullName}`,
      })
      .returning();
    return saved.id;
  }

  beforeAll(async () => {
    t = await createTestDb();
    ids[REPO] = await addRepo(t.db, REPO);
    ids[OTHER] = await addRepo(t.db, OTHER);
    ids[THIRD] = await addRepo(t.db, THIRD);
  });

  // Cada test arranca sin ideas: los repos son el único estado compartido.
  beforeEach(async () => {
    await t.db.delete(integrationIdea);
  });

  afterAll(async () => {
    await t?.close();
  });

  const fileIdea = (overrides: Partial<FileIdea> = {}): FileIdea => ({
    key: 'cobros-con-webhook',
    status: 'DRAFT',
    source: 'LLM',
    title: 'Cobros con webhook',
    summary: 'Escuchar pagos aprobados.',
    integrationType: 'WEBHOOK',
    difficulty: 'MEDIUM',
    triggers: [{ event: 'payment.succeeded', description: 'Se aprobó un cobro' }],
    snippet: { language: 'typescript', code: "app.post('/webhooks/pagos', handler);" },
    stackCompatibility: ['nextjs'],
    connectsWith: [],
    ...overrides,
  });

  // Idea sin clave, como las que deja el generador.
  const dbIdea = (repo: string, overrides: Record<string, unknown> = {}) =>
    createIntegrationIdea(t.db, {
      repositoryId: ids[repo],
      title: 'Auth con Supabase',
      summary: 'Login con email.',
      integrationType: 'SDK',
      snippet: { language: 'typescript', code: 'await supabase.auth.signInWithPassword(creds);' },
      stackCompatibility: ['react'],
      difficulty: 'LOW',
      source: 'LLM',
      ...overrides,
    });

  const files = (...ideas: FileIdea[]): IdeaFile[] => [{ repo: REPO, ideas }];
  const rows = () => t.db.select().from(integrationIdea);
  const byKey = async (key: string) => {
    const [saved] = await t.db.select().from(integrationIdea).where(eq(integrationIdea.key, key));
    return saved;
  };

  describe('apply', () => {
    it('inserta ideas nuevas con su clave, estado y fuente del archivo', async () => {
      const report = await applyIdeaFiles(t.db, files(fileIdea({ status: 'APPROVED' })));

      expect(report).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });
      expect(await byKey('cobros-con-webhook')).toMatchObject({
        repositoryId: ids[REPO],
        status: 'APPROVED',
        source: 'LLM',
        title: 'Cobros con webhook',
      });
    });

    it('es idempotente: una segunda corrida no cambia nada, ni updated_at', async () => {
      const input = files(fileIdea({ status: 'APPROVED' }));
      await applyIdeaFiles(t.db, input);
      const before = await rows();
      const report = await applyIdeaFiles(t.db, input);

      expect(report).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
      expect(await rows()).toEqual(before);
    });

    it('cambia el estado sin tocar la fuente', async () => {
      await applyIdeaFiles(t.db, files(fileIdea()));
      const report = await applyIdeaFiles(t.db, files(fileIdea({ status: 'REJECTED' })));

      expect(report.updated).toBe(1);
      expect(await byKey('cobros-con-webhook')).toMatchObject({
        status: 'REJECTED',
        source: 'LLM',
      });
    });

    it('pasa la fuente a HUMAN cuando una persona corrige el contenido de una idea del modelo', async () => {
      await applyIdeaFiles(t.db, files(fileIdea()));
      const corrected = fileIdea({ status: 'APPROVED', summary: 'Resumen corregido.' });
      const report = await applyIdeaFiles(t.db, files(corrected));

      expect(report.updated).toBe(1);
      expect(await byKey('cobros-con-webhook')).toMatchObject({
        status: 'APPROVED',
        source: 'HUMAN',
        summary: 'Resumen corregido.',
      });
    });

    it('HUMAN no vuelve a LLM aunque el archivo lo diga', async () => {
      await applyIdeaFiles(t.db, files(fileIdea({ source: 'HUMAN' })));
      await applyIdeaFiles(t.db, files(fileIdea({ source: 'LLM' })));
      expect((await byKey('cobros-con-webhook')).source).toBe('HUMAN');
    });

    it('resuelve connectsWith por nombre de repo a ids', async () => {
      await applyIdeaFiles(t.db, files(fileIdea({ connectsWith: [OTHER] })));
      expect((await byKey('cobros-con-webhook')).connectsWith).toEqual([ids[OTHER]]);
    });

    it('informa repos desconocidos sin abortar', async () => {
      const report = await applyIdeaFiles(t.db, [
        { repo: 'nadie/nada', ideas: [fileIdea({ key: 'huerfana' })] },
        ...files(fileIdea()),
      ]);

      expect(report.unknownRepos).toEqual(['nadie/nada']);
      expect(report.inserted).toBe(1);
    });

    it('informa ideas con connectsWith a repos desconocidos y no las guarda', async () => {
      const broken = fileIdea({ key: 'rota', title: 'Rota', connectsWith: ['nadie/nada'] });
      const report = await applyIdeaFiles(t.db, files(broken));

      expect(report.skipped).toEqual([
        { repo: REPO, key: 'rota', reason: expect.stringContaining('nadie/nada') },
      ]);
      expect(await rows()).toHaveLength(0);
    });

    it('adopta una idea sin clave (del generador) cuando título y contenido coinciden', async () => {
      const created = await dbIdea(OTHER);
      const adopted = fileIdea({
        key: 'auth-con-supabase',
        title: 'Auth con Supabase',
        summary: 'Login con email.',
        integrationType: 'SDK',
        triggers: [],
        snippet: { language: 'typescript', code: 'await supabase.auth.signInWithPassword(creds);' },
        stackCompatibility: ['react'],
        difficulty: 'LOW',
        status: 'APPROVED',
      });
      const report = await applyIdeaFiles(t.db, [{ repo: OTHER, ideas: [adopted] }]);

      expect(report).toMatchObject({ inserted: 0, updated: 1 });
      const [saved] = await t.db
        .select()
        .from(integrationIdea)
        .where(eq(integrationIdea.id, created.id));
      expect(saved).toMatchObject({ key: 'auth-con-supabase', status: 'APPROVED', source: 'LLM' });
    });

    it('no pega una idea nueva escrita a mano a una idea sin clave con el mismo título', async () => {
      const llm = await dbIdea(OTHER);
      const handWritten = fileIdea({
        key: 'auth-con-supabase',
        title: 'Auth con Supabase',
        summary: 'Otra idea distinta con el mismo título.',
        integrationType: 'SDK',
        triggers: [],
        snippet: null,
        difficulty: 'HIGH',
        source: 'HUMAN',
        status: 'APPROVED',
      });
      const report = await applyIdeaFiles(t.db, [{ repo: OTHER, ideas: [handWritten] }]);

      expect(report).toMatchObject({ inserted: 1, updated: 0 });
      expect(report.collisions).toEqual([{ repo: OTHER, key: 'auth-con-supabase' }]);
      const [untouched] = await t.db
        .select()
        .from(integrationIdea)
        .where(eq(integrationIdea.id, llm.id));
      expect(untouched).toMatchObject({ key: null, source: 'LLM', status: 'DRAFT' });
      expect(await byKey('auth-con-supabase')).toMatchObject({ source: 'HUMAN' });
    });

    it('ignora ids de repos que ya no existen en connectsWith: no marca HUMAN de más', async () => {
      await dbIdea(OTHER, { connectsWith: [ids[REPO], randomUUID()] });
      const exported = await exportIdeas(t.db);
      expect(exported[0].ideas[0].connectsWith).toEqual([REPO]);

      const report = await applyIdeaFiles(t.db, exported);

      expect(report.updated).toBe(1); // solo adopta la clave
      expect((await rows())[0].source).toBe('LLM');
      const again = await applyIdeaFiles(t.db, exported);
      expect(again).toMatchObject({ updated: 0, unchanged: 1 });
    });

    it('informa las ideas de la base que faltan en el archivo, sin borrarlas', async () => {
      await applyIdeaFiles(
        t.db,
        files(fileIdea(), fileIdea({ key: 'otra', title: 'Otra', status: 'APPROVED' })),
      );
      const report = await applyIdeaFiles(t.db, files(fileIdea()));

      expect(report.missing).toEqual([{ repo: REPO, key: 'otra' }]);
      expect(await rows()).toHaveLength(2);
    });

    it('no informa como faltantes las ideas de repos sin archivo', async () => {
      await dbIdea(OTHER);
      const report = await applyIdeaFiles(t.db, files(fileIdea()));
      expect(report.missing).toEqual([]);
    });

    it('resume estados y cobertura de repos con al menos una idea aprobada', async () => {
      await applyIdeaFiles(
        t.db,
        files(
          fileIdea({ status: 'APPROVED' }),
          fileIdea({ key: 'b', title: 'B', status: 'REJECTED' }),
          fileIdea({ key: 'c', title: 'C' }),
        ),
      );
      const report = await applyIdeaFiles(
        t.db,
        files(
          fileIdea({ status: 'APPROVED' }),
          fileIdea({ key: 'b', title: 'B', status: 'REJECTED' }),
          fileIdea({ key: 'c', title: 'C' }),
        ),
      );

      expect(report.statusCounts).toEqual({ DRAFT: 1, APPROVED: 1, REJECTED: 1 });
      expect(report.coverage).toEqual({ withApproved: 1, total: 3, percent: 33.3, goal: 90 });
    });

    it('no toca nada si alguna idea del archivo es inválida', async () => {
      await applyIdeaFiles(t.db, files(fileIdea()));
      const before = await rows();
      const invalid = fileIdea({ key: 'mala', triggers: [] }); // WEBHOOK sin disparadores
      await expect(
        applyIdeaFiles(t.db, files(fileIdea({ status: 'APPROVED' }), invalid)),
      ).rejects.toThrow(/mala/);
      expect(await rows()).toEqual(before);
    });
  });

  describe('applyCuration', () => {
    const embeddingReport = { generated: 0, skipped: 0, removed: 0, failed: [] };

    it('no genera embeddings si no se pide --embed', async () => {
      const generate = vi.fn(async () => embeddingReport);
      const result = await applyCuration(t.db, files(fileIdea()), { generate });

      expect(generate).not.toHaveBeenCalled();
      expect(result.embeddings).toBeNull();
      expect(result.report.inserted).toBe(1);
    });

    it('genera embeddings después de aplicar con --embed', async () => {
      const generate = vi.fn(async () => embeddingReport);
      const result = await applyCuration(t.db, files(fileIdea()), { embed: true, generate });

      expect(generate).toHaveBeenCalledWith(t.db);
      expect(result.embeddings).toEqual(embeddingReport);
    });
  });

  describe('export', () => {
    it('vuelca las ideas con claves estables y connectsWith por nombre', async () => {
      await applyIdeaFiles(
        t.db,
        files(
          fileIdea({ status: 'APPROVED', source: 'HUMAN' }),
          fileIdea({ key: 'con-conexion', title: 'Con conexión', connectsWith: [OTHER] }),
        ),
      );
      const exported = await exportIdeas(t.db);

      expect(exported.map((f) => f.repo)).toEqual([REPO]);
      expect(exported[0].ideas.map((i) => i.key)).toEqual(['cobros-con-webhook', 'con-conexion']);
      expect(exported[0].ideas[1].connectsWith).toEqual([OTHER]);
      expect(exported[0].ideas[0]).toMatchObject({ status: 'APPROVED', source: 'HUMAN' });
    });

    it('deriva la clave de ideas sin clave y no modifica la base', async () => {
      const orphan = await dbIdea(REPO, { title: 'Reintentos Idempotentes' });
      const before = await rows();

      const exported = await exportIdeas(t.db);

      expect(exported[0].ideas.map((i) => i.key)).toEqual(['reintentos-idempotentes']);
      expect(await rows()).toEqual(before);
      expect(orphan.key).toBeNull();
    });

    it('con archivos existentes conserva su estado, fuente y contenido (base desactualizada)', async () => {
      await applyIdeaFiles(t.db, files(fileIdea())); // la base sigue en DRAFT
      const reviewed = fileIdea({
        status: 'APPROVED',
        source: 'HUMAN',
        summary: 'Corregido por un compañero.',
      });

      const [merged] = await exportIdeas(t.db, files(reviewed));

      expect(merged.ideas).toEqual([reviewed]);
    });

    it('agrega las ideas de la base que no están en el archivo y conserva las que solo están en el archivo', async () => {
      await applyIdeaFiles(t.db, files(fileIdea({ key: 'nueva', title: 'Nueva' })));
      const onlyInFile = fileIdea({
        key: 'solo-archivo',
        title: 'Solo archivo',
        status: 'REJECTED',
      });

      const [merged] = await exportIdeas(t.db, files(onlyInFile));

      expect(merged.ideas.map((i) => [i.key, i.status])).toEqual([
        ['nueva', 'DRAFT'],
        ['solo-archivo', 'REJECTED'],
      ]);
    });

    it('escribe archivo para repos que todavía no tienen y deja de lado los demás', async () => {
      await dbIdea(OTHER);
      const merged = await exportIdeas(t.db, files(fileIdea()));
      expect(merged.map((f) => f.repo)).toEqual([OTHER]);
    });

    it('una idea sin clave con el mismo título que una del archivo pero otro contenido se agrega con sufijo', async () => {
      await dbIdea(REPO, { title: 'Cobros con webhook', integrationType: 'SDK', triggers: [] });
      const [merged] = await exportIdeas(t.db, files(fileIdea({ status: 'APPROVED' })));

      expect(merged.ideas.map((i) => i.key)).toEqual([
        'cobros-con-webhook',
        'cobros-con-webhook-2',
      ]);
      expect(merged.ideas[0].status).toBe('APPROVED');
    });

    it('export + apply en una base limpia reproduce las ideas', async () => {
      await applyIdeaFiles(
        t.db,
        files(
          fileIdea({ status: 'APPROVED', source: 'HUMAN' }),
          fileIdea({ key: 'con-conexion', title: 'Con conexión', connectsWith: [OTHER] }),
        ),
      );
      await dbIdea(REPO, { title: 'Reintentos Idempotentes' });
      const exported = await exportIdeas(t.db);

      const fresh = await createTestDb();
      try {
        for (const fullName of [REPO, OTHER, THIRD]) await addRepo(fresh.db, fullName);
        await applyIdeaFiles(fresh.db, exported);
        expect(await exportIdeas(fresh.db)).toEqual(exported);
        expect(await applyIdeaFiles(fresh.db, exported)).toMatchObject({ inserted: 0, updated: 0 });
      } finally {
        await fresh.close();
      }
    });

    it('export + apply reproduce dos ideas sin clave con el mismo título (sufijo -2)', async () => {
      await dbIdea(REPO, { title: 'Mismo título', summary: 'Primera.' });
      await dbIdea(REPO, { title: 'Mismo título', summary: 'Segunda.' });
      const exported = await exportIdeas(t.db);
      expect(exported[0].ideas.map((i) => i.key)).toEqual(['mismo-titulo', 'mismo-titulo-2']);

      const fresh = await createTestDb();
      try {
        for (const fullName of [REPO, OTHER, THIRD]) await addRepo(fresh.db, fullName);
        await applyIdeaFiles(fresh.db, exported);
        expect(await exportIdeas(fresh.db)).toEqual(exported);
        expect(
          (await fresh.db.select().from(integrationIdea)).map((r) => r.summary).sort(),
        ).toEqual(['Primera.', 'Segunda.']);
      } finally {
        await fresh.close();
      }
    });
  });
});
