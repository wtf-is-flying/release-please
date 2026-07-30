import {Scm} from '../scm';
import {
  CandidateReleasePullRequest,
  PythonWorkspaceLockfiles,
  RepositoryConfig,
} from '../manifest';
import {Version, VersionsMap} from '../version';
import {PullRequestTitle} from '../util/pull-request-title';
import {PullRequestBody} from '../util/pull-request-body';
import {ReleasePullRequest} from '../release-pull-request';
import {BranchName} from '../util/branch-name';
import {Changelog} from '../updaters/changelog';
import {
  WorkspacePlugin,
  DependencyGraph,
  DependencyNode,
  WorkspacePluginOptions,
  appendDependenciesSectionToChangelog,
  addPath,
} from './workspace';
import {Strategy} from '../strategy';
import {Commit} from '../commit';
import {Release} from '../release';
import {PatchVersionUpdate} from '../versioning-strategy';
import {ConfigurationError} from '../errors';
import {PyProject, parsePyProject} from '../updaters/python/pyproject-toml';
import {PyProjectTomlWorkspace} from '../updaters/python/pyproject-toml-workspace';
import {RawContent} from '../updaters/raw-content';
import {UvLock} from '../updaters/python/uv-lock';
import {Logger} from '../util/logger';

interface PythonPackageInfo {
  path: string;
  name: string;
  version: string;
  pyprojectPath: string;
  pyprojectContent: string;
  pyproject: PyProject;
  dependencies: string[];
}

interface PythonWorkspaceOptions extends WorkspacePluginOptions {
  lockfiles?: PythonWorkspaceLockfiles;
}

export class PythonWorkspace extends WorkspacePlugin<PythonPackageInfo> {
  private strategiesByPath: Record<string, Strategy> = {};
  private releasesByPath: Record<string, Release> = {};
  private packagePathsByName = new Map<string, string>();
  private lockfiles: PythonWorkspaceLockfiles;

  constructor(
    github: Scm,
    targetBranch: string,
    repositoryConfig: RepositoryConfig,
    options: PythonWorkspaceOptions = {}
  ) {
    super(github, targetBranch, repositoryConfig, options);
    this.lockfiles = options.lockfiles ?? {mode: 'global', path: 'uv.lock'};
  }

  protected async buildAllPackages(
    candidates: CandidateReleasePullRequest[]
  ): Promise<{
    allPackages: PythonPackageInfo[];
    candidatesByPackage: Record<string, CandidateReleasePullRequest>;
  }> {
    const candidatesByPath = new Map<string, CandidateReleasePullRequest>();
    for (const candidate of candidates) {
      candidatesByPath.set(candidate.path, candidate);
    }

    const candidatesByPackage: Record<string, CandidateReleasePullRequest> = {};
    const packages: PythonPackageInfo[] = [];
    this.packagePathsByName = new Map<string, string>();

    for (const path in this.repositoryConfig) {
      const config = this.repositoryConfig[path];
      if (config.releaseType !== 'python') {
        continue;
      }

      const pyprojectPath = addPath(path, 'pyproject.toml');
      const candidate = candidatesByPath.get(path);
      const content =
        candidate?.pullRequest.updates.find(
          update => update.path === pyprojectPath
        )?.cachedFileContents ??
        (await this.github.getFileContentsOnBranch(
          pyprojectPath,
          this.targetBranch
        ));
      const pyproject = parsePyProject(content.parsedContent);
      const project = pyproject.project;
      if (!project?.name) {
        throw new ConfigurationError(
          `package manifest at ${pyprojectPath} is missing [project.name]`,
          'python-workspace',
          `${this.github.repository.owner}/${this.github.repository.repo}`
        );
      }
      if (!project.version || typeof project.version !== 'string') {
        throw new ConfigurationError(
          `package manifest at ${pyprojectPath} is missing [project.version]`,
          'python-workspace',
          `${this.github.repository.owner}/${this.github.repository.repo}`
        );
      }

      const pkg: PythonPackageInfo = {
        path,
        name: project.name,
        version: project.version,
        pyprojectPath,
        pyprojectContent: content.parsedContent,
        pyproject,
        dependencies: project.dependencies || [],
      };
      packages.push(pkg);
      this.packagePathsByName.set(pkg.name, path);
      if (candidate) {
        candidatesByPackage[pkg.name] = candidate;
      }
    }

    return {
      allPackages: packages,
      candidatesByPackage,
    };
  }

  protected bumpVersion(pkg: PythonPackageInfo): Version {
    const version = Version.parse(pkg.version);
    return new PatchVersionUpdate().bump(version);
  }

  protected updateCandidate(
    existingCandidate: CandidateReleasePullRequest,
    pkg: PythonPackageInfo,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    const version = updatedVersions.get(pkg.name);
    if (!version) {
      throw new Error(`Didn't find updated version for ${pkg.name}`);
    }

    const updater = new PyProjectTomlWorkspace({
      version,
      versionsMap: updatedVersions,
    });
    const updatedContent = updater.updateContent(pkg.pyprojectContent);
    const dependencyNotes = getDependencyNotes(
      pkg.pyprojectContent,
      updatedContent,
      updatedVersions,
      this.logger
    );

    existingCandidate.pullRequest.updates =
      existingCandidate.pullRequest.updates.map(update => {
        if (update.path === pkg.pyprojectPath) {
          update.updater = new RawContent(updatedContent);
        } else if (update.updater instanceof Changelog && dependencyNotes) {
          update.updater.changelogEntry = appendDependenciesSectionToChangelog(
            update.updater.changelogEntry,
            dependencyNotes,
            this.logger
          );
        }
        return update;
      });

    if (dependencyNotes) {
      if (existingCandidate.pullRequest.body.releaseData.length > 0) {
        existingCandidate.pullRequest.body.releaseData[0].notes =
          appendDependenciesSectionToChangelog(
            existingCandidate.pullRequest.body.releaseData[0].notes,
            dependencyNotes,
            this.logger
          );
      } else {
        existingCandidate.pullRequest.body.releaseData.push({
          component: pkg.name,
          version: existingCandidate.pullRequest.version,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        });
      }
    }

    return existingCandidate;
  }

  protected async newCandidate(
    pkg: PythonPackageInfo,
    updatedVersions: VersionsMap
  ): Promise<CandidateReleasePullRequest> {
    const version = updatedVersions.get(pkg.name);
    if (!version) {
      throw new Error(`Didn't find updated version for ${pkg.name}`);
    }

    const updater = new PyProjectTomlWorkspace({
      version,
      versionsMap: updatedVersions,
    });
    const updatedContent = updater.updateContent(pkg.pyprojectContent);
    const dependencyNotes = getDependencyNotes(
      pkg.pyprojectContent,
      updatedContent,
      updatedVersions,
      this.logger
    );

    const strategy = this.strategiesByPath[pkg.path];
    const latestRelease = this.releasesByPath[pkg.path];
    const basePullRequest = strategy
      ? await strategy.buildReleasePullRequest([], latestRelease, false, [], {
          newVersion: version,
        })
      : undefined;

    if (basePullRequest) {
      return this.updateCandidate(
        {
          path: pkg.path,
          pullRequest: basePullRequest,
          config: {
            releaseType: 'python',
          },
        },
        pkg,
        updatedVersions
      );
    }

    const pullRequest: ReleasePullRequest = {
      title: PullRequestTitle.ofTargetBranch(this.targetBranch),
      body: new PullRequestBody([
        {
          component: pkg.name,
          version,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        },
      ]),
      updates: [
        {
          path: pkg.pyprojectPath,
          createIfMissing: false,
          updater: new RawContent(updatedContent),
        },
        {
          path: addPath(pkg.path, 'CHANGELOG.md'),
          createIfMissing: false,
          updater: new Changelog({
            version,
            changelogEntry: dependencyNotes,
          }),
        },
      ],
      labels: [],
      headRefName: BranchName.ofTargetBranch(this.targetBranch).toString(),
      version,
      draft: false,
    };

    return {
      path: pkg.path,
      pullRequest,
      config: {
        releaseType: 'python',
      },
    };
  }

  protected postProcessCandidates(
    candidates: CandidateReleasePullRequest[],
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest[] {
    if (candidates.length === 0 || updatedVersions.size === 0) {
      return candidates;
    }

    const targetCandidate =
      candidates.find(candidate => candidate.path === '.') ?? candidates[0];
    const lockfilePaths = this.getAffectedLockfiles(updatedVersions);
    for (const lockfilePath of lockfilePaths) {
      if (
        targetCandidate.pullRequest.updates.find(
          update => update.path === lockfilePath
        )
      ) {
        continue;
      }
      targetCandidate.pullRequest.updates.push({
        path: lockfilePath,
        createIfMissing: false,
        updater: new UvLock(updatedVersions),
      });
    }

    return candidates;
  }

  protected async buildGraph(
    allPackages: PythonPackageInfo[]
  ): Promise<DependencyGraph<PythonPackageInfo>> {
    const graph = new Map<string, DependencyNode<PythonPackageInfo>>();
    const workspacePackageNames = new Set(allPackages.map(pkg => pkg.name));

    for (const pkg of allPackages) {
      const deps: string[] = [];
      for (const dependency of pkg.dependencies) {
        const depName = parseDependencyName(dependency);
        if (depName && workspacePackageNames.has(depName)) {
          deps.push(depName);
        }
      }

      graph.set(pkg.name, {
        deps,
        value: pkg,
      });
    }

    return graph;
  }

  protected inScope(candidate: CandidateReleasePullRequest): boolean {
    return candidate.config.releaseType === 'python';
  }

  protected packageNameFromPackage(pkg: PythonPackageInfo): string {
    return pkg.name;
  }

  protected pathFromPackage(pkg: PythonPackageInfo): string {
    return pkg.path;
  }

  async preconfigure(
    strategiesByPath: Record<string, Strategy>,
    _commitsByPath: Record<string, Commit[]>,
    _releasesByPath: Record<string, Release>
  ): Promise<Record<string, Strategy>> {
    this.strategiesByPath = strategiesByPath;
    this.releasesByPath = _releasesByPath;
    return strategiesByPath;
  }

  private getAffectedLockfiles(updatedVersions: VersionsMap): string[] {
    if (this.lockfiles.mode === 'global') {
      return [this.lockfiles.path ?? 'uv.lock'];
    }

    const paths = new Set<string>();
    for (const packageName of updatedVersions.keys()) {
      const packagePath = this.packagePathsByName.get(packageName);
      if (!packagePath) {
        continue;
      }
      paths.add(addPath(packagePath, this.lockfiles.filename ?? 'uv.lock'));
    }
    return Array.from(paths).sort();
  }
}

function parseDependencyName(dependency: string): string | undefined {
  const match = dependency.match(
    /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]+\])?/
  );
  return match?.[1];
}

function getDependencyNotes(
  originalContent: string,
  updatedContent: string,
  updatedVersions: VersionsMap,
  logger: Logger
): string {
  const originalDependencies =
    parsePyProject(originalContent).project?.dependencies || [];
  const updatedDependencies =
    parsePyProject(updatedContent).project?.dependencies || [];

  const notes: string[] = [];
  for (let i = 0; i < updatedDependencies.length; i++) {
    const updatedDependency = updatedDependencies[i];
    const packageName = parseDependencyName(updatedDependency);
    if (!packageName) {
      continue;
    }
    if (!updatedVersions.get(packageName)) {
      logger.debug(`${packageName} was not bumped, ignoring`);
      continue;
    }
    const originalDependency = originalDependencies[i];
    if (!originalDependency || originalDependency === updatedDependency) {
      continue;
    }
    notes.push(
      `\n  * ${packageName} bumped from ${originalDependency} to ${updatedDependency}`
    );
  }

  if (notes.length > 0) {
    return `* The following workspace dependencies were updated${notes.join(
      ''
    )}`;
  }

  return '';
}
