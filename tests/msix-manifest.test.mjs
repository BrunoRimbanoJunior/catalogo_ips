import test from 'node:test';
import assert from 'node:assert/strict';
import { msixVersion, packageManifest } from '../scripts/msix-manifest.mjs';

test('Store version preserves SemVer ordering and reserves revision zero', () => {
  assert.equal(msixVersion('1.5.35'), '1.5.35.0');
  assert.equal(msixVersion('1.5.65535'), '1.5.65535.0');
  for (const value of ['1.5.65536', '1.5.35-beta.1', '1.5', '0.5.35', '1.5.35.1']) {
    assert.throws(() => msixVersion(value));
  }
});

test('Partner Center identity is preserved and XML text is escaped', () => {
  const identity = { name: 'Example.Catalogo', publisher: 'CN=ABC-123',
    publisherDisplayName: 'Fabricante & Cia', displayName: 'Catálogo "IPS" <Brasil>' };
  const manifest = packageManifest(identity, '1.5.35');
  assert.ok(manifest.includes('Name="Example.Catalogo" Publisher="CN=ABC-123"'));
  assert.ok(manifest.includes('Fabricante &amp; Cia'));
  assert.ok(manifest.includes('Catálogo &quot;IPS&quot; &lt;Brasil&gt;'));
  for (const key of ['name', 'publisher', 'publisherDisplayName', 'displayName']) {
    assert.throws(() => packageManifest({ ...identity, [key]: '' }, '1.5.35'));
  }
  assert.throws(() => packageManifest({ ...identity, name: '../invalid' }, '1.5.35'));
});
