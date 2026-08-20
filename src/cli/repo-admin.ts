import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { listRepositories, setRepositoryEnabled, upsertRepository } from '../db/repositories.js';

/**
 * Operator CLI for the repository registry (never exposed through MCP):
 *
 *   npm run repos -- list
 *   npm run repos -- add --key growth-engine --owner operava --repo growth-engine \
 *       [--default-branch main] [--allow-merge] [--concurrency 2] \
 *       [--workflows echo-check,fable] [--instructions "..."]
 *   npm run repos -- enable --key growth-engine
 *   npm run repos -- disable --key growth-engine
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const db = createPool(config);
  try {
    if (command === 'list' || command === undefined) {
      const repos = await listRepositories(db);
      if (repos.length === 0) {
        console.log('No repositories registered. Add one with: npm run repos -- add --key ... --owner ... --repo ...');
        return;
      }
      for (const r of repos) {
        console.log(
          `${r.key}${r.enabled ? '' : ' (disabled)'} → ${r.githubOwner}/${r.githubRepo} [default ${r.defaultBranch}] ` +
            `merge=${r.allowMerge ? 'yes' : 'no'} concurrency=${r.concurrencyLimit} workflows=${r.workflows.join(',') || '-'}`,
        );
      }
      return;
    }
    if (command === 'add') {
      const { values } = parseArgs({
        args: rest,
        options: {
          key: { type: 'string' },
          owner: { type: 'string' },
          repo: { type: 'string' },
          'default-branch': { type: 'string' },
          'allow-merge': { type: 'boolean' },
          concurrency: { type: 'string' },
          workflows: { type: 'string' },
          instructions: { type: 'string' },
        },
      });
      if (!values.key || !values.owner || !values.repo) {
        console.error('Required: --key --owner --repo');
        process.exit(1);
      }
      const repo = await upsertRepository(db, {
        key: values.key,
        githubOwner: values.owner,
        githubRepo: values.repo,
        defaultBranch: values['default-branch'],
        allowMerge: values['allow-merge'],
        concurrencyLimit: values.concurrency ? Number(values.concurrency) : undefined,
        workflows: values.workflows ? values.workflows.split(',').map((w) => w.trim()) : undefined,
        instructions: values.instructions,
      });
      console.log(`Registered "${repo.key}" → ${repo.githubOwner}/${repo.githubRepo}`);
      return;
    }
    if (command === 'enable' || command === 'disable') {
      const { values } = parseArgs({ args: rest, options: { key: { type: 'string' } } });
      if (!values.key) {
        console.error('Required: --key');
        process.exit(1);
      }
      const changed = await setRepositoryEnabled(db, values.key, command === 'enable');
      console.log(changed ? `Repository "${values.key}" ${command}d.` : `Repository "${values.key}" not found.`);
      return;
    }
    console.error(`Unknown command "${command}". Commands: list, add, enable, disable.`);
    process.exit(1);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
