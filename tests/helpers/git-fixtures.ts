import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../../src/gitx/git.js';
import { randomToken } from '../../src/ids.js';

/**
 * Local git fixtures: a bare repository standing in for GitHub. The
 * WorkspaceManager's remoteUrlFor override points at these paths, so the full
 * clone/branch/commit/push pipeline runs against real git without a network.
 */

export async function createBareRemote(root: string): Promise<string> {
  const barePath = path.join(root, `remote-${randomToken(8)}.git`);
  const seedPath = path.join(root, `seed-${randomToken(8)}`);
  await fs.mkdir(barePath, { recursive: true });
  await runGit(['init', '--bare', '--initial-branch=main', barePath]);
  await fs.mkdir(seedPath, { recursive: true });
  await runGit(['init', '--initial-branch=main', seedPath]);
  await runGit(['-C', seedPath, 'config', 'user.email', 'fixture@test.local']);
  await runGit(['-C', seedPath, 'config', 'user.name', 'Fixture']);
  await fs.writeFile(path.join(seedPath, 'README.md'), '# fixture repo\n');
  await fs.writeFile(path.join(seedPath, 'app.js'), 'console.log("v1");\n');
  await runGit(['-C', seedPath, 'add', '--all']);
  await runGit(['-C', seedPath, 'commit', '--no-verify', '-m', 'initial commit']);
  await runGit(['-C', seedPath, 'push', barePath, 'main:main']);
  await fs.rm(seedPath, { recursive: true, force: true });
  return barePath;
}

export async function remoteBranchHead(barePath: string, branch: string): Promise<string | null> {
  const result = await runGit(['--git-dir', barePath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowFailure: true,
  });
  const sha = result.stdout.trim();
  return result.code === 0 && sha.length > 0 ? sha : null;
}

/** Add a commit on top of a branch directly in the "remote" (like a reviewer pushing). */
export async function addRemoteCommit(
  barePath: string,
  branch: string,
  fileName: string,
  content: string,
): Promise<string> {
  const work = `${barePath}-work-${randomToken(6)}`;
  await runGit(['clone', '--branch', branch, '--', barePath, work]);
  await runGit(['-C', work, 'config', 'user.email', 'external@test.local']);
  await runGit(['-C', work, 'config', 'user.name', 'External']);
  await fs.writeFile(path.join(work, fileName), content);
  await runGit(['-C', work, 'add', '--all']);
  await runGit(['-C', work, 'commit', '--no-verify', '-m', `external change to ${fileName}`]);
  await runGit(['-C', work, 'push', 'origin', `${branch}:${branch}`]);
  const sha = (await runGit(['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  await fs.rm(work, { recursive: true, force: true });
  return sha;
}

/** Create a divergent commit (sibling of current head) and force the branch to it. */
export async function divergeRemoteBranch(barePath: string, branch: string): Promise<string> {
  const head = await remoteBranchHead(barePath, branch);
  if (!head) throw new Error(`branch ${branch} missing`);
  const parent = (
    await runGit(['--git-dir', barePath, 'rev-parse', `${head}^`], { allowFailure: true })
  ).stdout.trim();
  const base = parent || head;
  const work = `${barePath}-div-${randomToken(6)}`;
  await runGit(['clone', '--', barePath, work]);
  await runGit(['-C', work, 'config', 'user.email', 'external@test.local']);
  await runGit(['-C', work, 'config', 'user.name', 'External']);
  await runGit(['-C', work, 'checkout', '-b', 'divergent', base, '--']);
  await fs.writeFile(path.join(work, 'divergent.txt'), 'divergent history\n');
  await runGit(['-C', work, 'add', '--all']);
  await runGit(['-C', work, 'commit', '--no-verify', '-m', 'divergent commit']);
  const sha = (await runGit(['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  await runGit(['-C', work, 'push', '--force', 'origin', `divergent:${branch}`]);
  await fs.rm(work, { recursive: true, force: true });
  return sha;
}
