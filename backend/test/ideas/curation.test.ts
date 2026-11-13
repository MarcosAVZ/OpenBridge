import { describe, expect, it } from 'vitest';
import {
  assignKeys,
  ideaFileName,
  parseIdeaFile,
  reviewIdeas,
  serializeIdeaFile,
  slugify,
  type FileIdea,
  type IdeaFile,
} from '../../src/ideas/curation.js';

const idea = (overrides: Partial<FileIdea> = {}): FileIdea => ({
  key: 'cobros-con-webhook',
  status: 'DRAFT',
  source: 'LLM',
  title: 'Cobros con webhook',
  summary: 'Escuchar pagos aprobados.',
  integrationType: 'WEBHOOK',
  difficulty: 'MEDIUM',
  triggers: [{ event: 'payment.succeeded', description: 'Se aprobó un cobro' }],
  snippet: {
    language: 'typescript',
    code: "app.post('/webhooks/pagos', (req, res) => { res.sendStatus(200); });",
  },
  stackCompatibility: ['nextjs'],
  connectsWith: [],
  ...overrides,
});

const file = (ideas: FileIdea[], repo = 'stripe/stripe-node'): IdeaFile => ({ repo, ideas });

describe('slugify', () => {
  it('normaliza acentos, símbolos y espacios', () => {
    expect(slugify('  Sincronizar Sesión: Auth/DB  ')).toBe('sincronizar-sesion-auth-db');
  });

  it('usa un valor por defecto si no queda nada', () => {
    expect(slugify('¿¿??')).toBe('idea');
  });
});

describe('assignKeys', () => {
  it('conserva las claves existentes y deriva el resto sin repetir', () => {
    const keys = assignKeys([
      { id: 'a', key: null, title: 'Cobros' },
      { id: 'b', key: 'cobros', title: 'Otro título' },
      { id: 'c', key: null, title: 'Cobros' },
    ]);
    expect(keys.get('b')).toBe('cobros');
    expect(keys.get('a')).toBe('cobros-2');
    expect(keys.get('c')).toBe('cobros-3');
  });
});

describe('ideaFileName', () => {
  it('convierte owner/name en un nombre de archivo', () => {
    expect(ideaFileName('stripe/stripe-node')).toBe('stripe__stripe-node.yaml');
  });
});

describe('serializeIdeaFile / parseIdeaFile', () => {
  it('hace ida y vuelta sin perder datos', () => {
    const original = file([idea(), idea({ key: 'otra', title: 'Otra', snippet: null })]);
    const roundTrip = parseIdeaFile(serializeIdeaFile(original));
    expect(roundTrip.repo).toBe(original.repo);
    expect(roundTrip.ideas).toEqual([...original.ideas].sort((a, b) => a.key.localeCompare(b.key)));
  });

  it('es determinista: ordena las ideas por clave', () => {
    const a = serializeIdeaFile(file([idea({ key: 'b' }), idea({ key: 'a' })]));
    const b = serializeIdeaFile(file([idea({ key: 'a' }), idea({ key: 'b' })]));
    expect(a).toBe(b);
    expect(a.indexOf('key: a')).toBeLessThan(a.indexOf('key: b'));
  });

  it('rechaza una idea inválida indicando el repo y la clave', () => {
    const text = serializeIdeaFile(file([idea({ triggers: [] })]));
    expect(() => parseIdeaFile(text)).toThrow(/stripe\/stripe-node.*cobros-con-webhook/s);
  });

  it('rechaza un estado desconocido', () => {
    const text = serializeIdeaFile(file([idea()])).replace('DRAFT', 'MAYBE');
    expect(() => parseIdeaFile(text)).toThrow(/status/);
  });

  it('rechaza claves repetidas en el mismo repo', () => {
    const text = serializeIdeaFile(file([idea(), idea()]));
    expect(() => parseIdeaFile(text)).toThrow(/repetida/);
  });
});

describe('reviewIdeas', () => {
  const known = new Set(['stripe/stripe-node', 'supabase/supabase']);
  const codes = (ideas: FileIdea[]) =>
    reviewIdeas([file(ideas)], known).flatMap((flagged) => flagged.flags.map((f) => f.code));

  it('no marca una idea razonable', () => {
    expect(codes([idea()])).toEqual([]);
  });

  it('marca snippet ausente', () => {
    expect(codes([idea({ snippet: null })])).toContain('SNIPPET_EMPTY');
  });

  it('marca snippet trivialmente corto', () => {
    expect(codes([idea({ snippet: { language: 'ts', code: 'x()' } })])).toContain('SNIPPET_SHORT');
  });

  it('marca repetición degenerada (caso LOGOUT_)', () => {
    const code = `const url = '${'LOGOUT_'.repeat(30)}'; fetch(url);`;
    expect(
      codes([idea({ integrationType: 'REST_API', snippet: { language: 'ts', code } })]),
    ).toContain('DEGENERATE_REPETITION');
  });

  it('marca repetición degenerada en el resumen', () => {
    expect(codes([idea({ summary: 'token '.repeat(40) })])).toContain('DEGENERATE_REPETITION');
  });

  it('marca DOCKER sin contenido de docker o compose', () => {
    const snippet = { language: 'typescript', code: 'const total = items.reduce(sum, 0);' };
    expect(codes([idea({ integrationType: 'DOCKER', triggers: [], snippet })])).toContain(
      'TYPE_MISMATCH',
    );
  });

  it('acepta DOCKER con docker-compose', () => {
    const snippet = {
      language: 'yaml',
      code: 'services:\n  app:\n    image: supabase/postgres:15\n    ports: ["5432:5432"]',
    };
    expect(codes([idea({ integrationType: 'DOCKER', triggers: [], snippet })])).toEqual([]);
  });

  it('marca connectsWith hacia repos desconocidos', () => {
    const [flagged] = reviewIdeas([file([idea({ connectsWith: ['nadie/nada'] })])], known);
    expect(flagged.flags.map((f) => f.code)).toContain('UNKNOWN_CONNECTION');
    expect(flagged.flags[0].detail).toContain('nadie/nada');
  });

  it('solo revisa ideas en DRAFT', () => {
    expect(codes([idea({ status: 'APPROVED', snippet: null })])).toEqual([]);
    expect(codes([idea({ status: 'REJECTED', snippet: null })])).toEqual([]);
  });

  it('identifica repo y clave de cada idea marcada', () => {
    const [flagged] = reviewIdeas([file([idea({ snippet: null })])], known);
    expect(flagged).toMatchObject({ repo: 'stripe/stripe-node', key: 'cobros-con-webhook' });
  });
});
