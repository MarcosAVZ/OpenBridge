import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntegrationIdea } from '../../src/db/integration-ideas.js';
import { integrationIdea, repository } from '../../src/db/schema.js';
import { applyIdeaFiles, exportIdeas } from '../../src/ideas/curation-db.js';
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
    ids[THIRD] = await addRepo(t.db, THIRD); // sin ideas: baja la cobertura
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
      const before = await rows();
      const report = await applyIdeaFiles(t.db, files(fileIdea({ status: 'APPROVED' })));

      expect(report).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
      expect(await rows()).toEqual(before);
    });

    it('cambia el estado sin tocar la fuente', async () => {
      const report = await applyIdeaFiles(t.db, files(fileIdea({ status: 'REJECTED' })));

      expect(report.updated).toBe(1);
      expect(await byKey('cobros-con-webhook')).toMatchObject({
        status: 'REJECTED',
        source: 'LLM',
      });
    });

    it('pasa la fuente a HUMAN cuando una persona corrige el contenido de una idea del modelo', async () => {
      const corrected = fileIdea({
        status: 'APPROVED',
        summary: 'Resumen corregido por una persona.',
      });
      const report = await applyIdeaFiles(t.db, files(corrected));

      expect(report.updated).toBe(1);
      expect(await byKey('cobros-con-webhook')).toMatchObject({
        status: 'APPROVED',
        source: 'HUMAN',
        summary: 'Resumen corregido por una persona.',
      });
    });

    it('HUMAN no vuelve a LLM aunque el archivo lo diga', async () => {
      const corrected = fileIdea({
        status: 'APPROVED',
        summary: 'Resumen corregido por una persona.',
      });
      await applyIdeaFiles(t.db, files(corrected));
      expect((await byKey('cobros-con-webhook')).source).toBe('HUMAN');
    });

    it('resuelve connectsWith por nombre de repo a ids', async () => {
      const linked = fileIdea({
        key: 'con-conexion',
        title: 'Con conexión',
        connectsWith: [OTHER],
      });
      await applyIdeaFiles(t.db, files(linked));
      expect((await byKey('con-conexion')).connectsWith).toEqual([ids[OTHER]]);
    });

    it('informa repos desconocidos sin abortar', async () => {
      const linked = fileIdea({
        key: 'con-conexion',
        title: 'Con conexión',
        connectsWith: [OTHER],
      });
      const report = await applyIdeaFiles(t.db, [
        { repo: 'nadie/nada', ideas: [fileIdea({ key: 'huerfana' })] },
        ...files(linked),
      ]);

      expect(report.unknownRepos).toEqual(['nadie/nada']);
      expect(report.unchanged).toBe(1);
    });

    it('informa ideas con connectsWith a repos desconocidos y no las guarda', async () => {
      const before = await rows();
      const broken = fileIdea({ key: 'rota', title: 'Rota', connectsWith: ['nadie/nada'] });
      const report = await applyIdeaFiles(t.db, files(broken));

      expect(report.skipped).toEqual([
        { repo: REPO, key: 'rota', reason: expect.stringContaining('nadie/nada') },
      ]);
      expect(await rows()).toHaveLength(before.length);
    });

    it('adopta una idea existente sin clave (generada por el modelo) por su título', async () => {
      const created = await createIntegrationIdea(t.db, {
        repositoryId: ids[OTHER],
        title: 'Auth con Supabase',
        summary: 'Login con email.',
        integrationType: 'SDK',
        snippet: { language: 'typescript', code: 'await supabase.auth.signInWithPassword(creds);' },
        stackCompatibility: ['react'],
        difficulty: 'LOW',
        source: 'LLM',
      });
      expect(created.key).toBeNull();

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

    it('resume estados y cobertura de repos con al menos una idea aprobada', async () => {
      const report = await applyIdeaFiles(t.db, []);

      expect(report.coverage).toEqual({ withApproved: 2, total: 3, percent: 66.7, goal: 90 });
      expect(report.statusCounts).toEqual({ DRAFT: 0, APPROVED: 0, REJECTED: 0 });
    });

    it('no toca nada si alguna idea del archivo es inválida', async () => {
      const before = await rows();
      const invalid = fileIdea({ key: 'mala', triggers: [] }); // WEBHOOK sin disparadores
      await expect(applyIdeaFiles(t.db, files(invalid))).rejects.toThrow(/mala/);
      expect(await rows()).toEqual(before);
    });
  });

  describe('export', () => {
    it('vuelca las ideas con claves estables y connectsWith por nombre', async () => {
      const exported = await exportIdeas(t.db);

      expect(exported.map((f) => f.repo)).toEqual([REPO, OTHER]);
      const stripe = exported.find((f) => f.repo === REPO);
      expect(stripe?.ideas.map((i) => i.key)).toEqual(['cobros-con-webhook', 'con-conexion']);
      expect(stripe?.ideas.find((i) => i.key === 'con-conexion')?.connectsWith).toEqual([OTHER]);
      expect(stripe?.ideas[0]).toMatchObject({ status: 'APPROVED', source: 'HUMAN' });
    });

    it('deriva la clave de ideas sin clave y no modifica la base', async () => {
      const orphan = await createIntegrationIdea(t.db, {
        repositoryId: ids[REPO],
        title: 'Reintentos Idempotentes',
        summary: 'Usar claves de idempotencia.',
        integrationType: 'REST_API',
        snippet: null,
        stackCompatibility: ['node'],
        difficulty: 'LOW',
        source: 'LLM',
      });
      const before = await rows();

      const exported = await exportIdeas(t.db);

      const keys = exported.find((f) => f.repo === REPO)?.ideas.map((i) => i.key);
      expect(keys).toContain('reintentos-idempotentes');
      expect(await rows()).toEqual(before);
      expect(orphan.key).toBeNull();
    });

    it('export + apply en una base limpia reproduce las ideas', async () => {
      const exported = await exportIdeas(t.db);
      const fresh = await createTestDb();
      try {
        for (const fullName of [REPO, OTHER, THIRD]) await addRepo(fresh.db, fullName);
        await applyIdeaFiles(fresh.db, exported);
        expect(await exportIdeas(fresh.db)).toEqual(exported);
        const second = await applyIdeaFiles(fresh.db, exported);
        expect(second).toMatchObject({ inserted: 0, updated: 0 });
      } finally {
        await fresh.close();
      }
    });
  });

  it('apply no llama a ningún proveedor externo (Ollama es opt-in en la CLI)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await applyIdeaFiles(t.db, []);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
