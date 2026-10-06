# Distribuição MSIX pela Microsoft Store

O produto MSIX tem identidade própria no Partner Center. Copie sem alterar letras
ou maiúsculas os campos `Package/Identity/Name`, `Package/Identity/Publisher` e
`Package/Properties/PublisherDisplayName` para `store-identity.json`. Esses dados
são públicos. Nenhuma chave privada ou certificado é necessário para upload à
Store, que assina o pacote após a certificação.
O arquivo `store-identity.json` contém a identidade confirmada deste produto.
O nome reservado é **Catálogo Yokomitsu**, com identidade de pacote
`BrunoRImbanoJunior.CatlogoYokomitsu`.
Para outro produto, copie `store-identity.example.json` e preencha os valores
da página de identidade do Partner Center, incluindo o nome completo.

## Gerar o pacote

Pré-requisitos: Windows x64, Node/pnpm, dependências instaladas, Rust/MSVC e Windows
SDK com `MakeAppx.exe` e `MakePri.exe`. Configure as variáveis públicas do Supabase
em `.env.production`, como no build desktop existente.

```powershell
pnpm.cmd msix:build
```

O comando compila o código atual em `src-tauri/target/msix`, gera os recursos da
Store e grava `dist-msix/catalogo_ips_<versão>.0_x64.msix` com seu SHA256. A versão
MSIX deriva da versão estável de `package.json`: `1.5.35` vira `1.5.35.0` (a Store
reserva o último componente). Para outra identidade use
`pnpm.cmd msix:build -- --identity caminho.json`.

O pacote inclui apenas executável/DLLs de runtime, ícones, banco inicial,
manifesto de catálogo e índice de recursos. O banco e o hash são validados antes
e depois do build. O manifesto empacotado é sincronizado em uma cópia isolada;
o `manifest.json` versionado permanece intacto. A edição da Store desativa o
plugin de atualização do Tauri, a consulta de releases e o botão de instalador
do GitHub. Banco e imagens continuam sendo sincronizados pela URL de manifesto.

## Testar antes de enviar

O MSIX de upload não tem assinatura local. Para sideload, é preciso assinar uma
cópia com certificado de desenvolvimento e configurar confiança na máquina de
teste. Outra opção, em máquina com Modo de Desenvolvedor habilitado, é registrar
o diretório de staging informado pelo build:

```powershell
Add-AppxPackage -Register 'CAMINHO_DO_STAGING\AppxManifest.xml'
```

Abra pelo menu Iniciar e confira login, catálogo inicial, consulta, imagens,
impressão/exportação e sincronização do banco. A implantação de desenvolvimento
não substitui a certificação da Store. Execute também o Windows App Certification
Kit antes da submissão final.

Esta edição usa o WebView2 Evergreen do sistema, pré-instalado no Windows 11 e na
maioria das máquinas Windows 10. O manifesto declara `Microsoft.WebView2` como
dependência externa para o App Installer. Essa declaração é ignorada por outros
mecanismos de instalação; teste a presença do runtime também em máquina limpa.
O pacote tem como mínimo Windows 10 2004 (build 19041), arquitetura x64.

## Enviar para a Store

Na submissão do produto MSIX, abra **Pacotes** e envie o `.msix` gerado. A edição
Store deve receber futuras versões do executável pelo mesmo produto, mantendo
identidade e aumentando a versão. Atualizar só `data/catalog.db` continua usando
o workflow `manifest`, sem exigir uma submissão nova de aplicativo.

Declare a necessidade de `runFullTrust` nas notas de certificação: o aplicativo é
desktop Win32/Tauri e precisa acessar SQLite, cache de imagens e arquivos de
exportação do usuário. Complete a política de privacidade, descrição, capturas e
as instruções de acesso para a equipe de certificação. A publicação ocorre após
a aprovação da Microsoft; gerar o pacote não publica o produto.

Referências: [empacotamento manual](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion),
[requisitos MSIX da Store](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements),
[dependência externa WebView2](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-win32dependencies-externaldependency).
