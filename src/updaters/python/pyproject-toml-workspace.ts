import {logger as defaultLogger, Logger} from '../../util/logger';
import {replaceTomlValue} from '../../util/toml-edit';
import {DefaultUpdater} from '../default';
import {Version} from '../../version';
import {parsePyProject} from './pyproject-toml';

const DEPENDENCY_NAME_REGEX =
  /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]+\])?(\s*)(.*)$/;

function updateLowerBound(
  dependency: string,
  newVersion: Version
): string | undefined {
  const match = dependency.match(DEPENDENCY_NAME_REGEX);
  if (!match) {
    return undefined;
  }

  const [, name, extras = '', whitespace = '', remainder = ''] = match;
  const trimmedRemainder = remainder.trim();

  if (!trimmedRemainder) {
    return `${name}${extras}${whitespace}>=${newVersion.toString()}`;
  }

  if (trimmedRemainder.startsWith('@')) {
    return undefined;
  }

  const [specifierPart, ...markerParts] = trimmedRemainder.split(';');
  const markerSuffix =
    markerParts.length > 0 ? ` ;${markerParts.join(';').trimStart()}` : '';
  const normalizedSpecifier = specifierPart.trim();

  if (
    normalizedSpecifier.includes('===') ||
    normalizedSpecifier.includes('==')
  ) {
    return undefined;
  }

  if (normalizedSpecifier.match(/>=\s*[^,\s;]+/)) {
    const nextSpecifier = normalizedSpecifier.replace(
      />=\s*[^,\s;]+/,
      `>=${newVersion.toString()}`
    );
    return `${name}${extras}${whitespace}${nextSpecifier}${markerSuffix}`;
  }

  return `${name}${extras}${whitespace}>=${newVersion.toString()},${normalizedSpecifier}${markerSuffix}`;
}

export class PyProjectTomlWorkspace extends DefaultUpdater {
  updateContent(content: string, logger: Logger = defaultLogger): string {
    const parsed = parsePyProject(content);
    const project = parsed.project;

    if (!project?.version) {
      if (project?.dynamic && project.dynamic.includes('version')) {
        logger.warn(
          "dynamic version found in 'pyproject.toml'. Skipping update."
        );
        return content;
      }

      const msg = 'invalid file';
      logger.error(msg);
      throw new Error(msg);
    }

    let payload = replaceTomlValue(
      content,
      ['project', 'version'],
      this.version.toString()
    );

    const dependencies = parsed.project?.dependencies || [];
    for (let i = 0; i < dependencies.length; i++) {
      const dependency = dependencies[i];
      const match = dependency.match(DEPENDENCY_NAME_REGEX);
      if (!match) {
        continue;
      }
      const packageName = match[1];
      const nextVersion = this.versionsMap?.get(packageName);
      if (!nextVersion) {
        continue;
      }
      const nextDependency = updateLowerBound(dependency, nextVersion);
      if (!nextDependency || nextDependency === dependency) {
        continue;
      }
      payload = replaceTomlValue(
        payload,
        ['project', 'dependencies', i.toString()],
        nextDependency
      );
    }

    return payload;
  }
}
