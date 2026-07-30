import {describe, it} from 'mocha';
import {expect} from 'chai';
import {Version} from '../../src/version';
import {UvLock} from '../../src/updaters/python/uv-lock';

describe('UvLock', () => {
  it('updates managed package versions in uv.lock', async () => {
    const oldContent = `version = 1
revision = 3

[[package]]
name = "pkg-a"
version = "1.2.3"
source = { editable = "../a" }

[[package]]
name = "pkg-b"
version = "0.4.0"
source = { editable = "." }
`;

    const updater = new UvLock(
      new Map([
        ['pkg-a', Version.parse('1.3.0')],
        ['pkg-b', Version.parse('0.4.1')],
      ])
    );

    const newContent = updater.updateContent(oldContent);
    expect(newContent).to.contain('name = "pkg-a"\nversion = "1.3.0"');
    expect(newContent).to.contain('name = "pkg-b"\nversion = "0.4.1"');
  });
});
