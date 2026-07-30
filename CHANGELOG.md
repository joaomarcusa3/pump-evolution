# Changelog

Todas as mudanças relevantes deste pacote são documentadas aqui. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue
[SemVer](https://semver.org/lang/pt-BR/). As entradas de release são geradas via
[Changesets](https://github.com/changesets/changesets).

## [Unreleased]

### Added

- **Suporte a MCP servers** (`kind: mcp`): `modelId` condicional e atributo
  `cta.item_kind` nos spans.
- **Telemetria governada de tools MCP**: `traceMcpTool` e `instrumentMcpServer`
  (identidade + compliance contra `allowedTools` + segurança OWASP-LLM),
  reaproveitando o mesmo pipeline dos agentes.
- **Autenticação do consumidor via Cognito**: `ConsumerTokenVerifier` (JWKS RS256,
  issuer/audience/expiração, fail-closed, sem dependências externas) e
  `claimsToUserContext`.
- **`runWithIdentity(authorizationHeader, fn)`**: valida o JWT do caller e propaga
  a identidade a todos os spans numa única chamada — para agentes e MCPs.

### Changed

- Empacotamento: `exports` dual ESM/CJS com _types por condição_,
  `sideEffects: false` e `keywords` para tree-shaking e resolução de tipos correta.

### Security

- `runWithIdentity`/`ConsumerTokenVerifier` são fail-closed: token ausente ou
  inválido não executa a função protegida.
- Findings de segurança/compliance são redigidos: registram apenas o rótulo da
  regra e a localização, nunca o valor sensível.
