import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ideaSource, ideaStatus } from '../db/schema.js';
import { ideaContentSchema, requireWebhookTriggers } from './schema.js';

// Curaduría versionada de ideas (OB-19). Cada repo con ideas tiene un archivo
// seed/ideas/<owner>__<name>.yaml; una idea se identifica por (repo, key), no
// por el uuid de la base, así el archivo sirve en cualquier base nueva.

// Mínimo de caracteres para que un fragmento no sea trivial.
const MIN_SNIPPET_LENGTH = 20;
// Una unidad de 3 a 40 caracteres repetida 8 veces seguidas no es código real.
const REPETITION = /(.{3,40}?)\1{7,}/s;

export const fileIdeaSchema = ideaContentSchema
  .extend({
    key: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'La clave tiene que ser un slug en minúsculas'),
    status: z.enum(ideaStatus.enumValues),
    source: z.enum(ideaSource.enumValues),
    connectsWith: z.array(z.string().trim().min(1)).default([]),
  })
  .superRefine(requireWebhookTriggers);

export type FileIdea = z.output<typeof fileIdeaSchema>;
export interface IdeaFile {
  repo: string;
  ideas: FileIdea[];
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'idea';
}

export function ideaFileName(repo: string): string {
  return `${repo.replace('/', '__')}.yaml`;
}

// Claves de las ideas de un repo, en el orden recibido: las que ya tienen se
// respetan y al resto se les deriva una del título, con sufijo -2, -3 si se repite.
export function assignKeys(
  ideas: { id: string; key: string | null; title: string }[],
): Map<string, string> {
  const keys = new Map<string, string>();
  const taken = new Set<string>();
  for (const { id, key } of ideas) {
    if (key) {
      keys.set(id, key);
      taken.add(key);
    }
  }
  for (const { id, key, title } of ideas) {
    if (key) continue;
    const base = slugify(title);
    let candidate = base;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
    taken.add(candidate);
    keys.set(id, candidate);
  }
  return keys;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Orden fijo de los campos y de las ideas para que el diff de un PR muestre
// solo lo que cambió.
export function serializeIdeaFile({ repo, ideas }: IdeaFile): string {
  const ordered = [...ideas]
    .sort((a, b) => byText(a.key, b.key))
    .map((i) => ({
      key: i.key,
      status: i.status,
      source: i.source,
      title: i.title,
      summary: i.summary,
      integrationType: i.integrationType,
      difficulty: i.difficulty,
      triggers: i.triggers,
      snippet: i.snippet,
      stackCompatibility: i.stackCompatibility,
      connectsWith: [...i.connectsWith].sort(byText),
    }));
  return stringify({ repo, ideas: ordered }, { lineWidth: 0 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Valida cada idea con el mismo esquema de contenido que usa el generador y
// reporta el error con repo y clave, para encontrarlo rápido en el PR.
export function parseIdeaFile(source: string): IdeaFile {
  const document: unknown = parse(source);
  if (!isRecord(document) || typeof document.repo !== 'string' || !Array.isArray(document.ideas)) {
    throw new Error('El archivo de ideas debe tener "repo" y un arreglo "ideas"');
  }
  const repo = document.repo;
  const seen = new Set<string>();
  const ideas = document.ideas.map((entry: unknown, index) => {
    const label = `${repo} (idea ${index + 1}${isRecord(entry) ? `, ${String(entry.key)}` : ''})`;
    const result = fileIdeaSchema.safeParse(entry);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(idea)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Idea inválida en ${label}: ${details}`);
    }
    if (seen.has(result.data.key)) {
      throw new Error(`Clave repetida en ${repo}: ${result.data.key}`);
    }
    seen.add(result.data.key);
    return result.data;
  });
  return { repo, ideas };
}

export type ReviewFlagCode =
  | 'SNIPPET_EMPTY'
  | 'SNIPPET_SHORT'
  | 'DEGENERATE_REPETITION'
  | 'TYPE_MISMATCH'
  | 'UNKNOWN_CONNECTION';

export interface ReviewFlag {
  code: ReviewFlagCode;
  detail: string;
}

export interface FlaggedIdea {
  repo: string;
  key: string;
  title: string;
  flags: ReviewFlag[];
}

// Lo que se espera ver en el fragmento según el tipo de integración.
const TYPE_EVIDENCE: Partial<Record<FileIdea['integrationType'], RegExp>> = {
  DOCKER: /docker|compose|\bFROM\s+\S|\bimage:|services:|container/i,
  CLI: /\s--?[a-z]|\b(npx?|pnpm|yarn|pip|brew|cargo|curl|wget|bash|argv|spawn|exec)\b|\bcli\b/i,
  REST_API:
    /https?:|\bfetch\b|axios|curl|request|\.(get|post|put|patch|delete)\(|endpoint|\/api\//i,
  WEBHOOK: /webhook|hook|signature|event|payload|\.post\(|\bPOST\b/i,
};

const collapse = (text: string) => text.replace(/\s+/g, ' ');

// Chequeos objetivos de la checklist sobre ideas en DRAFT. Solo marcan: la
// decisión de aprobar o rechazar es de una persona.
export function reviewIdeas(files: IdeaFile[], knownRepos: ReadonlySet<string>): FlaggedIdea[] {
  const flagged: FlaggedIdea[] = [];
  for (const { repo, ideas } of files) {
    for (const idea of ideas) {
      if (idea.status !== 'DRAFT') continue;
      const flags: ReviewFlag[] = [];
      const code = idea.snippet?.code.trim() ?? '';

      if (!idea.snippet || code === '') {
        flags.push({ code: 'SNIPPET_EMPTY', detail: 'No tiene fragmento de código' });
      } else if (code.length < MIN_SNIPPET_LENGTH) {
        flags.push({
          code: 'SNIPPET_SHORT',
          detail: `El fragmento tiene ${code.length} caracteres (mínimo ${MIN_SNIPPET_LENGTH})`,
        });
      }

      const repeated = [
        ['title', idea.title],
        ['summary', idea.summary],
        ['snippet', code],
      ].find(([, text]) => REPETITION.test(collapse(text)));
      if (repeated) {
        flags.push({
          code: 'DEGENERATE_REPETITION',
          detail: `Texto repetido en ${repeated[0]}: ${collapse(repeated[1]).match(REPETITION)?.[1]?.trim()}`,
        });
      }

      const evidence = TYPE_EVIDENCE[idea.integrationType];
      if (evidence && code !== '' && !evidence.test(code)) {
        flags.push({
          code: 'TYPE_MISMATCH',
          detail: `El fragmento no muestra nada propio de una integración ${idea.integrationType}`,
        });
      }

      const unknown = idea.connectsWith.filter((name) => !knownRepos.has(name));
      if (unknown.length > 0) {
        flags.push({
          code: 'UNKNOWN_CONNECTION',
          detail: `connectsWith apunta a repos desconocidos: ${unknown.join(', ')}`,
        });
      }

      if (flags.length > 0) flagged.push({ repo, key: idea.key, title: idea.title, flags });
    }
  }
  return flagged;
}
