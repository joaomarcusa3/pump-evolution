# Changelog

Todas as mudanças relevantes deste pacote são documentadas aqui. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue
[SemVer](https://semver.org/lang/pt-BR/). As entradas de release são geradas via
[Changesets](https://github.com/changesets/changesets).

## [Unreleased]

## [0.1.0] - 2026-08-29

Primeira versao que reune as duas linhagens do SDK: o trabalho do GitLab
(correcoes de MCP, portoes de pipeline, `CognitoLogin`) e o do GitHub do Joao
(`ManagedAgentClient`, catalogo de modelos, manifesto como fonte unica). Minor
porque a superficie publica cresce; nada existente quebra.

### Added

- **`ManagedAgentClient`** (ADR-0068) — hospedagem no runtime AgentCore
  gerenciado da plataforma, TypeScript e Python. `fromManifest()` le
  `runtime.managed`, que o `cta_factory_hospedar_runtime` ja grava; o scope de
  invoke e derivado (`cta-consumers/invoke:agent:<agentId>`) quando nao vem
  declarado. A credencial de invoke **nunca** entra no manifesto — e show-once e
  vive no ambiente.
- **Selecao dinamica de modelo** — `invoke` aceita override de `modelId` por
  invocacao, nas duas linguagens.
- **`runtime.models`** no manifesto — snapshot que o portal escreve do catalogo
  Bedrock habilitado na conta. E snapshot, nao lista mantida a mao: a
  disponibilidade autoritativa continua atras da API.
- **`runtime.managed`** — `ManifestManagedRuntime` e validacao nos dois loaders.

### Changed

- `runtime.cognito` e `runtime.managed` fazem do manifesto a fonte unica de
  configuracao: o dev nao copia mais `COGNITO_*` nem `PUMP_MANAGED_*` a mao.

### Notas da reconciliacao

As duas linhagens divergiram porque o trabalho do GitLab (!15-!22) foi reaplicado
no GitHub por conteudo, nao por merge de historico. Este merge estabelece o
ancestral comum — as proximas sincronizacoes passam a ser baratas.

Onde as duas versoes conflitaram (36 blocos em 14 arquivos), o criterio foi:

- **nosso lado** onde a !23 tocou. A versao do GitHub exigia
  `runtime.cognito.issuer` e `scopes`, e por isso rejeitava o `manifest.yaml` do
  `tpz-cel926-cmdb-jira-assets` que esta em producao — o mesmo defeito que a
  validacao contra o conector real revelou aqui;
- **o lado dele** em tudo que e adicao nova.

O codigo que veio do GitHub nunca havia passado pelos portoes desta pipeline.
Passou agora: typecheck, lint, 268 testes TypeScript e 71 Python, relatorio de
API regenerado.

## [0.0.9] - 2026-08-28

### Fixed

- **`runtime.cognito` exigia `issuer` e rejeitava manifesto que está em
  produção.** Validando a 0.0.8 contra o `manifest.yaml` real do
  `tpz-cel926-cmdb-jira-assets`, o `fromManifest()` lançou: aquele bloco foi
  gerado antes de a plataforma passar a emitir `issuer`, e eu havia tornado os
  cinco campos obrigatórios.

  Agora só `domain`, `clientId` e `redirectUri` são obrigatórios — sem eles o
  login aponta para lugar nenhum. `issuer` e `scopes` são opcionais: o primeiro
  só habilita a checagem de `iss` (que o `aud` já cobre em boa parte, amarrando o
  token ao App Client), e o segundo tem default. Recusar o bloco antigo quebraria
  um conector no ar para ganhar uma checagem a mais.

  Teste de regressão nas duas linguagens, com o formato exato do manifesto que
  está deployado.

### Verificado

Validação ponta a ponta contra o Cognito real (pool `us-east-1_5ppMHdWW7`, conta
166488239644), confrontando o que o SDK gera com o App Client provisionado:

| | |
| --- | --- |
| `authorization_endpoint` do discovery | idêntico à URL que o SDK monta do `domain` |
| `AllowedOAuthFlows` | `['code']` — bate com `response_type=code` |
| `CallbackURLs` | exatamente o `redirect_uri` que o SDK envia |
| `ClientSecret` | `null` — client público, e o SDK não manda Basic auth |
| `AllowedOAuthScopes` | `email openid profile` — bate com o `scope` enviado |

O `scopes_supported` do discovery inclui `phone`, que o App Client **não** aceita.
O SDK escapa disso por usar os scopes do manifesto (os do client) e nunca os do
discovery — é a mesma pegadinha que derruba proxies OAuth com `invalid_scope`.
## [0.0.8] - 2026-08-28

### Added

- **`CognitoLogin` — login de usuário final** (TypeScript). Fecha o contrato que
  a plataforma já entrega em produção: o `cta_factory_provisionar_cognito`
  provisiona o App Client (`authorization_code` + PKCE) no pool da plataforma,
  grava `runtime.cognito` no manifesto e imprime o bloco `COGNITO_*` — e até
  agora nenhuma versão publicada do SDK sabia ler nada disso.

  É a identidade das PESSOAS que usam o componente, distinta do service account
  de telemetria (`client_credentials`), que autentica o processo. As duas nunca
  se cruzam: um token de `client_credentials` não tem usuário e, portanto, não
  tem departamento — que é justamente por que esta segunda identidade precisou
  existir.

  - **`CognitoLogin.fromManifest('./manifest.yaml')`** — caminho preferido. Lê
    `runtime.cognito` inteiro, incluindo `issuer`, `identityProviders`,
    `identityProvider` e `logoutRedirectUri`. Nada é copiado à mão, e o bloco é
    git-safe: a plataforma nunca escreve secret nele (um client confidencial
    continua lendo `COGNITO_CLIENT_SECRET` do ambiente).
  - **`CognitoLogin.fromEnv()`** — lê o bloco `COGNITO_*`, agora incluindo
    `COGNITO_ISSUER` e `COGNITO_IDENTITY_PROVIDER`.
  - **`identity_provider` no authorize** — leva o usuário direto ao SSO, pulando
    a tela de usuário/senha. Só é enviado quando a plataforma o emite, o que ela
    faz apenas com EXATAMENTE UM IdP federado no pool; com dois ou mais o campo é
    omitido de propósito, e o SDK cai na tela de escolha em vez de adivinhar e
    mandar a pessoa para o SSO errado.
  - Handlers Express/Connect prontos (`/auth/login`, `/auth/callback`,
    `/auth/logout`) sem importar `express`, mais as primitivas para qualquer
    framework.

- **Paridade Python** — `pump_evolution.integrations.cognito.CognitoLogin`, no
  caminho de import exato que a plataforma documenta. Mesmo contrato:
  `from_manifest()`, `from_env()`, as primitivas, e `install(app)` montando
  `/auth/login`, `/auth/callback` e `/auth/logout`. `user_resolver` e
  `id_token_resolver` casam com o `PumpIdentityMiddleware` que já existia.

  As rotas são testadas contra **Starlette real** — cliente HTTP, app e sessão de
  verdade. Duplo de app só confirmaria o formato que imaginei, que foi como o
  `instrument_mcp_server` passou meses sem instrumentar o servidor de baixo nível
  com a suíte verde. `starlette`, `itsdangerous` e `httpx` entram como
  dev-dependencies só para isso.

- **`runtime.cognito` no manifesto** — `ManifestCognito` e validação no
  `manifest-loader`. Os cinco campos que a plataforma sempre emite são
  obrigatórios quando o bloco existe: um bloco pela metade falharia depois, no
  Hosted UI, com mensagem opaca — em vez de aqui, no load, nomeando o campo.

### Security

Quatro decisões que valem registro, todas verificadas por teste:

- **Redirect pós-login restrito a caminho same-site.** `startsWith('/')` sozinho
  deixa passar `//evil.com` e `/\evil.com`, que o browser lê como URL
  protocol-relative — open redirect num usuário JÁ AUTENTICADO. `safeNextPath`
  rejeita os dois.
- **`iss`, `aud` e `exp` do `id_token` são conferidos.** A assinatura não é (o
  token vem do próprio token endpoint sobre TLS, OIDC Core 3.1.3.7), mas token
  expirado numa sessão longa atribuiria spans a quem saiu horas atrás, e token de
  outro pool viraria identidade sem ninguém notar.
- **Falha de login não é silenciosa.** `exchangeCode` devolve o motivo E reporta
  no `logger` injetável, com o `error_description` do Cognito — que é o que
  distingue secret errado de `redirect_uri` divergente. Sem isso, um 401 vira um
  302 indistinguível de sucesso.
- **`state` comparado em tempo constante**, e limpo da sessão antes de qualquer
  retorno — callback replicado não reaproveita.

Logout sem `logoutRedirectUri` avisa pelo logger que a sessão do Cognito
continua viva: limpar só a sessão local faz o próximo login não pedir nada, e o
usuário jura que deslogou.

## [0.0.7] - 2026-08-27

### Added

- **`py/README.md`**, que o `py/pyproject.toml` declarava em `readme` sem que o
  arquivo existisse — o build tolerava, mas era declaração falsa e o pacote
  Python ia para os integradores sem documentação própria. Cobre instalação,
  init, Bedrock, MCP (com a tabela de qual classe cai em qual caminho),
  identidade e shutdown. Todos os exemplos foram executados antes de commitar:
  `UserContext` e `McpToolInvocation` são dataclasses, não dicts, e a primeira
  versão do texto errava os dois.

- **O `build_vendor_zip.py` passa a levar o `py/README.md` para
  `python/src/`**, ao lado do `pyproject.toml` que o declara. Sem isso o README
  existiria no repositório e não no pacote — a documentação do lado Python nunca
  chegaria em quem integra, que é o único lugar onde ela importa. A montagem
  agora falha se o arquivo sumir, em vez de publicar um pacote sem docs.

### Changed

- O `publish-s3` passa a documentar **quais permissões de IAM o usuário de CI
  precisa** e por quê: `PutObject` e `GetObject` no prefixo `sdk/*`, mais
  `ListBucket` no bucket. O `ListBucket` não é redundante — sem ele o
  `HeadObject` responde 403 até para chave inexistente, em vez de 404, e o guard
  não consegue distinguir "não existe" de "não posso ver". O usuário não está em
  Terraform nenhum, então a exigência não aparecia em `plan` de ninguém; agora
  está junto do código que depende dela.

## [0.0.6] - 2026-08-27

### Fixed

- **O guard contra republicação não guardava nada.** Introduzido na 0.0.5, ele
  colapsava as três respostas possíveis do `head-object` num único
  `if ... >/dev/null 2>&1`, então qualquer erro — inclusive `AccessDenied` por a
  credencial de CI não ter `s3:GetObject` — era lido como "a chave não existe" e
  a publicação seguia por cima. Foi exatamente o que aconteceu: o merge seguinte
  sobrescreveu `sdk/pump-evolution-0.0.5.zip` sem uma linha no log sobre a
  verificação.

  Os três casos passam a ser distintos: chave existente bloqueia; `404` publica;
  **qualquer outra falha para a pipeline e mostra a resposta crua da AWS**, em vez
  de publicar no escuro. Um portão que degrada em silêncio não é portão — foi a
  lição que o `instrumentMcpServer` deu neste mesmo release, repetida por descuido
  no shell.

## [0.0.5] - 2026-08-27

> ⚠️ **Não confie no número 0.0.4.** Ele foi publicado duas vezes, com conteúdos
> diferentes — a primeira com a correção do MCP no TypeScript, a segunda também
> com a do Python. A 0.0.3 passou pela mesma coisa. Nos três casos o merge entrou
> em `main` sem bump e a chave versionada no S3 foi sobrescrita. `__version__` e
> `SDK_USER_AGENT` respondem `0.0.4` nas duas, então **não há como distinguir uma
> da outra sem ler o código**.
>
> Se você integrou com qualquer versão até a 0.0.4, **baixe a 0.0.5**. A partir
> desta versão o `publish-s3` recusa republicar uma versão existente, então a
> ambiguidade não se repete.

### Quem precisa agir

**Conector MCP em Python que chama `instrument_mcp_server`.** Em toda versão até
a 0.0.4 esse caminho não deixava o servidor sem telemetria — deixava o servidor
**inoperante**. As tools eram registradas com o nome errado e com um schema que
torna a chamada impossível:

```
tools registradas : ['traced_handler']

ToolError: Error executing tool traced_handler: 2 validation errors
  call_args    Field required
  call_kwargs  Field required
```

O sintoma é inconfundível: o `tools/list` responde com uma tool só, chamada
`traced_handler`, e **toda chamada de tool falha** com erro de validação do
pydantic. Se o seu conector responde e executa tools normalmente, ele não passou
por aqui e não há nada a fazer.

**Quem NÃO precisa agir:** conector já em produção enviando telemetria. Nada
neste release altera código deployado — o SDK é vendorizado no build de cada
componente, não baixado em runtime. A atualização só acontece quando você
decide refazer o build.

### Ao atualizar para a 0.0.5

Mudança de comportamento a conhecer: `instrument_mcp_server` (nas duas
linguagens) agora **lança** quando o servidor não expõe nenhuma superfície de
tool reconhecida, em vez de devolvê-lo intacto. Antes esse caminho jamais emitia
um span enquanto o processo se dizia instrumentado. Se o seu servidor tem formato
próprio, embrulhe cada handler com `trace_mcp_tool` / `traceMcpTool` em vez de
contar com a instrumentação automática.

### Fixed

- **`instrument_mcp_server` (Python) QUEBRAVA o servidor FastMCP**, não apenas
  deixava de instrumentá-lo. Ele procurava `register_tool`/`tool`/`add_tool` e
  embrulhava o último argumento callable — mas em `add_tool(fn, name=None, ...)`
  a função é o PRIMEIRO argumento. O wrapper cru `(*args, **kwargs)` substituía a
  função original, e como o FastMCP tira o nome da tool de `fn.__name__` e o
  `inputSchema` da assinatura, **toda tool passava a se chamar `traced_handler`
  com schema `{call_args, call_kwargs}`**. Os dois caminhos de registro
  (`@mcp.tool()` e `add_tool`) desembocavam nisso.

  Agora a função é embrulhada com `functools.wraps`, preservando
  `__name__`/`__doc__`/`__annotations__` e a assinatura via `__wrapped__` — nome,
  descrição e schema saem intactos. Funções `async` mantêm o formato, que é o que
  o FastMCP checa com `iscoroutinefunction`.

- **O servidor de baixo nível não emitia span nenhum** — paridade com a correção
  do TypeScript na 0.0.4. `mcp.server.lowlevel.Server` não tem `add_tool` nem
  `tool`: despacha por `call_tool()` no `mcp` 1.x e por
  `add_request_handler("tools/call", ...)` no 2.x. Os dois caminhos passam a ser
  instrumentados, cada tool despachada vira um span próprio, e um despacho já
  registrado antes da chamada é instrumentado também.

- **Servidor de formato desconhecido agora falha alto**, como no TypeScript: sem
  `add_tool`/`tool` nem `call_tool`/`add_request_handler`, `instrument_mcp_server`
  lança em vez de devolver o servidor intacto. Instrumentar o mesmo servidor duas
  vezes é no-op, e o caminho `tool()` → `add_tool()` do FastMCP não duplica span.

### Added

- **Testes de MCP no Python** (`py/tests/test_mcp_instrumentation.py`), contra o
  pacote `mcp` REAL — o de baixo nível ponta a ponta (cliente ↔ streams em
  memória ↔ servidor). Rodam nas duas majors: `FastMCP`/`MCPServer` e os dois
  formatos de registro de baixo nível. 13 dos 14 falham no código anterior.

- **Portão de qualidade do Python no CI** (`quality-python`). O SDK tem duas
  implementações e só a de TypeScript tinha portão — a suíte Python nunca rodou
  na pipeline. Só `pytest`: `ruff` e `mypy` acusam 382 e 11 achados
  pré-existentes, sem config no `pyproject`, e ligá-los é trabalho próprio.

## [0.0.4] - 2026-08-27

### Fixed

- **`instrumentMcpServer` era no-op silencioso na classe `Server` (baixo nível)**:
  a função embrulhava apenas `registerTool` e `tool`, que existem só na classe
  `McpServer` (alto nível) do `@modelcontextprotocol/sdk`. Um servidor construído
  sobre a classe `Server` despacha tools por
  `setRequestHandler(CallToolRequestSchema, …)` e não tem nenhum dos dois —
  recebia o servidor de volta intacto e NUNCA emitia um span de tool. Agora o
  handler de `tools/call` também é embrulhado, com nome e input tirados de
  `params.name` / `params.arguments`; um handler já registrado antes da chamada é
  instrumentado igual. Instrumentar o mesmo servidor duas vezes é no-op (sem span
  duplicado).

  Impacto: o `cta-factory-mcp` da plataforma usa a classe `Server`. Config,
  credencial, endpoint e permissão IAM estavam corretos, o boot logava telemetria
  ativa, e nenhum span de tool chegava ao portal. Nada falhava — typecheck, lint,
  build e os testes com fakes passavam.

- **Servidor de formato desconhecido agora falha alto**: se o objeto não expõe
  nem `registerTool`/`tool` nem `setRequestHandler`, `instrumentMcpServer` lança
  em vez de devolver o servidor intacto. Silêncio ali contraria o princípio de
  zero fallbacks — nenhum span sairia e o processo continuaria se dizendo
  instrumentado. O SDK desabilitado não é afetado: o handle no-op nem chega lá.

### Added

- Testes contra o `@modelcontextprotocol/sdk` REAL
  (`tests/mcp-instrumentation.real-sdk.test.ts`) — cliente e servidor ligados por
  transport in-memory, para as duas classes. Fake de servidor MCP não prova
  instrumentação: era justamente por isso que a suíte passava com o bug. O SDK
  MCP e o `zod` entram como devDependencies só para esses testes.

## [0.0.3] - 2026-08-26

### Fixed

- **Tokens em respostas de streaming (Python)**: `converse_stream` e
  `invoke_model_with_response_stream` emitiam o span SEM `gen_ai.usage.*`, e
  portanto sem custo. O span era finalizado no retorno da chamada, mas o retorno
  imediato de `converse_stream` traz apenas o campo `stream` — o `usage` chega no
  evento `metadata`, no fim. O campo iteravel passa a ser envolvido por um
  observador que repassa cada evento inalterado e finaliza o span depois do
  consumo, com o `usage` observado. Restaura a paridade com `observeStream` do
  TypeScript, que ja fazia isso. O span termina exatamente uma vez em qualquer
  caminho: consumo completo, `break` antecipado (`GeneratorExit`) ou erro
  genuino, re-levantado inalterado.

  Impacto: agentes Python que usam streaming no Bedrock (por exemplo via
  `astream` do LangChain) apareciam no portal com token e custo zerados.

### Added

- Suite de testes Python (`py/tests/`) — ate entao so o TypeScript tinha testes.


## [0.0.2] - 2026-08-19

### Fixed

- **Fallback de `department`**: quando `custom:department` está ausente, cai para
  o claim real `custom:topaz_directorate` (alias `custom:cta_directorate`),
  usado como valor direto — sem inventar campos (`custom:topaz_area` não existe
  na plataforma). Aplica-se a `extractIdentity` (headers) e `claimsToUserContext`
  (consumer-auth), em TS e Python.

## [0.0.1]

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
