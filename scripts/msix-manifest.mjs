export function msixVersion(version) {
  // Store reserves the fourth component; SemVer prereleases are not Store builds.
  if (!/^[1-9]\d*\.\d+\.\d+$/.test(version)) {
    throw new Error('A versão do app deve ser SemVer estável, por exemplo 1.5.35.');
  }
  const parts = version.split('.').map(Number);
  if (parts.some((part) => part > 65535)) throw new Error('Componentes MSIX não podem exceder 65535.');
  return `${parts.join('.')}.0`;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

export function packageManifest(identity, version) {
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identity.name || '')) {
    throw new Error('Identidade MSIX: name deve ser o Package/Identity/Name exato do Partner Center (3–50 caracteres).');
  }
  for (const key of ['publisher', 'publisherDisplayName', 'displayName']) {
    if (!String(identity[key] || '').trim()) throw new Error(`Identidade MSIX: ${key} obrigatório.`);
  }
  if (!identity.publisher.startsWith('CN=')) throw new Error('publisher deve ser o DN exato fornecido pela Store.');
  const v = msixVersion(version);
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:win32dependencies="http://schemas.microsoft.com/appx/manifest/externaldependencies"
  IgnorableNamespaces="uap uap10 rescap win32dependencies">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${v}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${xml(identity.displayName)}</DisplayName>
    <PublisherDisplayName>${xml(identity.publisherDisplayName)}</PublisherDisplayName>
    <Description>Consulta de peças automotivas do Catálogo IPS do Brasil.</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="pt-BR" /></Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
    <win32dependencies:ExternalDependency Name="Microsoft.WebView2"
      Publisher="CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"
      MinVersion="109.0.1518.0" Optional="false" />
  </Dependencies>
  <Applications>
    <Application Id="CatalogoIPS" Executable="catalogo_ips.exe"
      uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="${xml(identity.displayName)}"
        Description="Consulta de peças automotivas do Catálogo IPS do Brasil."
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png" BackgroundColor="transparent" />
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
`;
}
