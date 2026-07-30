import {describe, it, afterEach, beforeEach} from 'mocha';
import * as sinon from 'sinon';
import {expect} from 'chai';
import {GitHub} from '../../src/github';
import {ManifestPlugin} from '../../src/plugin';
import {CandidateReleasePullRequest} from '../../src/manifest';
import {Update} from '../../src/update';
import {Version} from '../../src/version';
import {PythonWorkspace} from '../../src/plugins/python-workspace';
import {
  assertHasUpdate,
  buildGitHubFileRaw,
  buildMockCandidatePullRequest,
  readFixture,
  stubFilesFromFixtures,
} from '../helpers';
import {PyProjectToml} from '../../src/updaters/python/pyproject-toml';

const sandbox = sinon.createSandbox();
const fixturesPath = './test/fixtures/plugins/python-workspace';

function buildMockPyProjectUpdate(path: string, content: string): Update {
  return {
    path,
    createIfMissing: false,
    cachedFileContents: buildGitHubFileRaw(content),
    updater: new PyProjectToml({
      version: Version.parse('1.0.0'),
    }),
  };
}

describe('PythonWorkspace plugin', () => {
  let github: GitHub;
  let plugin: ManifestPlugin;

  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'googleapis',
      repo: 'python-test-repo',
      defaultBranch: 'main',
    });
    plugin = new PythonWorkspace(github, 'main', {
      'packages/pkg-a': {
        releaseType: 'python',
      },
      'packages/pkg-b': {
        releaseType: 'python',
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('does nothing for non-python strategies', async () => {
    const candidates: CandidateReleasePullRequest[] = [
      buildMockCandidatePullRequest('node', 'node', '1.0.0'),
    ];
    const newCandidates = await plugin.run(candidates);
    expect(newCandidates).to.eql(candidates);
  });

  it('updates a single python package and attaches the global uv.lock', async () => {
    const pkgAContent = readFixture(
      fixturesPath,
      'packages/pkg-a/pyproject.toml'
    );
    plugin = new PythonWorkspace(github, 'main', {
      'packages/pkg-a': {
        releaseType: 'python',
      },
    });
    const candidates: CandidateReleasePullRequest[] = [
      buildMockCandidatePullRequest('packages/pkg-a', 'python', '1.3.0', {
        component: 'pkg-a',
        updates: [
          buildMockPyProjectUpdate(
            'packages/pkg-a/pyproject.toml',
            pkgAContent
          ),
        ],
      }),
    ];

    stubFilesFromFixtures({
      sandbox,
      github,
      fixturePath: fixturesPath,
      files: ['packages/pkg-a/pyproject.toml'],
      flatten: false,
      targetBranch: 'main',
    });

    const newCandidates = await plugin.run(candidates);
    expect(newCandidates).to.have.lengthOf(1);
    const updates = newCandidates[0].pullRequest.updates;
    assertHasUpdate(updates, 'packages/pkg-a/pyproject.toml');
    assertHasUpdate(updates, 'uv.lock');
  });

  it('patch bumps dependents, rewrites dependency bounds, and only updates affected per-package locks', async () => {
    const pkgAContent = readFixture(
      fixturesPath,
      'packages/pkg-a/pyproject.toml'
    );
    stubFilesFromFixtures({
      sandbox,
      github,
      fixturePath: fixturesPath,
      files: ['packages/pkg-a/pyproject.toml', 'packages/pkg-b/pyproject.toml'],
      flatten: false,
      targetBranch: 'main',
    });

    plugin = new PythonWorkspace(
      github,
      'main',
      {
        'packages/pkg-a': {
          releaseType: 'python',
        },
        'packages/pkg-b': {
          releaseType: 'python',
        },
      },
      {
        lockfiles: {
          mode: 'per-package',
          filename: 'uv.lock',
        },
      }
    );

    const candidates: CandidateReleasePullRequest[] = [
      buildMockCandidatePullRequest('packages/pkg-a', 'python', '1.3.0', {
        component: 'pkg-a',
        updates: [
          buildMockPyProjectUpdate(
            'packages/pkg-a/pyproject.toml',
            pkgAContent
          ),
        ],
      }),
    ];

    const newCandidates = await plugin.run(candidates);
    expect(newCandidates).to.have.lengthOf(1);

    const updates = newCandidates[0].pullRequest.updates;
    const pkgBUpdate = assertHasUpdate(
      updates,
      'packages/pkg-b/pyproject.toml'
    );
    assertHasUpdate(updates, 'packages/pkg-a/uv.lock');
    assertHasUpdate(updates, 'packages/pkg-b/uv.lock');
    const updatedPkgB = pkgBUpdate.updater.updateContent(
      readFixture(fixturesPath, 'packages/pkg-b/pyproject.toml')
    );
    expect(updatedPkgB).to.contain('version = "0.4.1"');
    expect(updatedPkgB).to.contain('"pkg-a>=1.3.0"');
  });
});
