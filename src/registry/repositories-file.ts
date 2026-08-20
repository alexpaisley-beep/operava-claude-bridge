import fs from 'node:fs/promises';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { upsertRepository } from '../db/repositories.js';
import { BridgeError } from '../errors.js';
import type { Logger } from '../logger.js';

/**
 * Optional declarative repository registry bootstrap. When REPOSITORIES_FILE
 * points at a JSON file, its entries are upserted into the registry at boot —
 * a controlled, reviewable way to add repositories. The `repos` CLI offers the
 * same imperatively.
 */

export const repositoryFileEntrySchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  githubOwner: z.string().min(1),
  githubRepo: z.string().min(1),
  defaultBranch: z.string().optional(),
  enabled: z.boolean().optional(),
  allowCodeChanges: z.boolean().optional(),
  allowCommit: z.boolean().optional(),
  allowPush: z.boolean().optional(),
  allowOpenPr: z.boolean().optional(),
  allowUpdatePr: z.boolean().optional(),
  allowMerge: z.boolean().optional(),
  concurrencyLimit: z.number().int().min(1).max(16).optional(),
  instructions: z.string().optional(),
  workflows: z.array(z.string()).optional(),
});

export type RepositoryFileEntry = z.infer<typeof repositoryFileEntrySchema>;

export async function syncRepositoriesFromFile(
  db: Db,
  filePath: string,
  logger: Logger,
): Promise<number> {
  const raw = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BridgeError('INTERNAL_ERROR', `REPOSITORIES_FILE is not valid JSON: ${filePath}`, { cause: err });
  }
  const result = z.array(repositoryFileEntrySchema).safeParse(parsed);
  if (!result.success) {
    throw new BridgeError('INTERNAL_ERROR', `REPOSITORIES_FILE failed validation: ${result.error.message}`);
  }
  for (const entry of result.data) {
    await upsertRepository(db, entry);
    logger.info({ repository: entry.key }, 'repository registry entry synced');
  }
  return result.data.length;
}
