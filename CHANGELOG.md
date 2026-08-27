# Changelog

Todas as mudanças relevantes deste pacote são documentadas aqui. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue
[SemVer](https://semver.org/lang/pt-BR/). As entradas de release são geradas via
[Changesets](https://github.com/changesets/changesets).

## [Unreleased]

## [0.0.5] - 2026-08-27

> ⚠️ **Não confie no número 0.0.4.** Ele foi publicado duas vezes, com conteúdos
> diferentes — a primeira com a correção do MCP no TypeScript, a segunda também
> com a do Python. A 0.0.3 passou pela mesma coisa. Nos três casos o merge entrou
> em `main` sem bump e a chave versionada no S3 foi sobrescrita. `__version__` e
> `SDK_USER_AGENT` respondem `0.0.4` nas duas, então **não há como distinguir uma
> da outra sem ler o código**.
>
> Se você integrou com qualquer versão até a 0.0.4, **baixe a 0.0.5**. Vale
> especialmente para conector MCP em Python: em tudo que veio antes desta versão,
> `instrument_mcp_server` renomeava as tools do FastMCP para `traced_handler` —
> o sintoma é o `tools/list` do seu servidor responder com uma tool só, com esse
> nome. A partir da 0.0.5 o `publish-s3` recusa republicar uma versão existente,
> então isso não se repete.

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
