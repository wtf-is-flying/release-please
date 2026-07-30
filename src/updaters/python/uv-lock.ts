import {replaceTomlValue} from '../../util/toml-edit';
import {logger as defaultLogger, Logger} from '../../util/logger';
import {Updater} from '../../update';
import {VersionsMap} from '../../version';
import * as TOML from '@iarna/toml';

interface UvLockfilePackage {
  name?: string;
  version?: string;
}

interface UvLockfile {
  package?: UvLockfilePackage[];
}

function parseUvLockfile(content: string): UvLockfile {
  return TOML.parse(content) as UvLockfile;
}

export class UvLock implements Updater {
  versionsMap: VersionsMap;
  constructor(versionsMap: VersionsMap) {
    this.versionsMap = versionsMap;
  }

  updateContent(content: string, logger: Logger = defaultLogger): string {
    let payload = content;

    const parsed = parseUvLockfile(payload);
    if (!parsed.package) {
      logger.error('is not a uv lockfile');
      throw new Error('is not a uv lockfile');
    }

    for (let i = 0; i < parsed.package.length; i++) {
      const pkg = parsed.package[i];
      if (!pkg.name) {
        continue;
      }

      const nextVersion = this.versionsMap.get(pkg.name);
      if (!nextVersion) {
        continue;
      }

      payload = replaceTomlValue(
        payload,
        ['package', i.toString(), 'version'],
        nextVersion.toString()
      );
    }

    return payload;
  }
}
