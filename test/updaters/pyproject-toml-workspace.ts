import {describe, it} from 'mocha';
import {expect} from 'chai';
import {Version} from '../../src/version';
import {PyProjectTomlWorkspace} from '../../src/updaters/python/pyproject-toml-workspace';

describe('PyProjectTomlWorkspace', () => {
  it('updates project version and managed dependency lower bounds', async () => {
    const oldContent = `[project]
name = "pkg-b"
version = "0.4.0"
dependencies = [
  "pkg-a>=1.2.3",
  "requests>=2.0",
  "pkg-c<2",
]
`;

    const updater = new PyProjectTomlWorkspace({
      version: Version.parse('0.4.1'),
      versionsMap: new Map([
        ['pkg-a', Version.parse('1.3.0')],
        ['pkg-c', Version.parse('2.1.0')],
      ]),
    });

    const newContent = updater.updateContent(oldContent);
    expect(newContent).to.contain('version = "0.4.1"');
    expect(newContent).to.contain('"pkg-a>=1.3.0"');
    expect(newContent).to.contain('"requests>=2.0"');
    expect(newContent).to.contain('"pkg-c>=2.1.0,<2"');
  });

  it('leaves exact pins alone', async () => {
    const oldContent = `[project]
name = "pkg-b"
version = "0.4.0"
dependencies = ["pkg-a==1.2.3"]
`;

    const updater = new PyProjectTomlWorkspace({
      version: Version.parse('0.4.1'),
      versionsMap: new Map([['pkg-a', Version.parse('1.3.0')]]),
    });

    const newContent = updater.updateContent(oldContent);
    expect(newContent).to.contain('"pkg-a==1.2.3"');
  });
});
