# pump-evolution (Python)

SDK de telemetria governada para agentes de IA e servidores MCP em Python.
Emite spans OpenTelemetry GenAI para o Control Tower AI com identidade, tokens,
custo, compliance e sinais de segurança OWASP-LLM. Paridade com o
`@topaz-ia/pump-evolution` (Node) — mesmo manifesto, mesmos atributos de span,
mesmo receiver.

Zero dependências internas `cta-*`. Distribuído como zip no S3, servido pela
plataforma em `GET /api/sdk/download` — não está no PyPI público.

## Instalar

```bash
curl -fL -o pump-evolution.zip <url-da-plataforma>/api/sdk/download
unzip pump-evolution.zip
pip install ./pump-evolution/python/src
```

Para instrumentar Bedrock, o extra `bedrock` traz o `boto3`:

```bash
pip install "./pump-evolution/python/src[bedrock]"
```

## Inicializar (uma vez, no boot)

```python
import os
from pump_evolution import PumpEvolution, ServiceAccountCredentials, PumpConfig

pump = PumpEvolution.init(
    PumpConfig(
        manifest="./manifest.yaml",
        service_account=ServiceAccountCredentials(
            client_secret=os.environ["PUMP_SERVICE_ACCOUNT_CLIENT_SECRET"],
            token_url=os.environ["PUMP_SERVICE_ACCOUNT_TOKEN_URL"],
        ),
    )
)
```

O SDK só liga com `PUMP_EVOLUTION_ENABLED=true`; fora isso o handle é no-op e
não valida nada. Ligado, ele valida manifesto e config **no boot** — sem default
silencioso.

`endpoint` e `serviceAccountId` saem do manifesto (`runtime.telemetry`); segredo
e `token_url` vêm sempre do ambiente.

## Agente Bedrock

```python
import boto3

bedrock = pump.instrument_bedrock(boto3.client("bedrock-runtime"))
```

Cobre `converse`, `converse_stream`, `invoke_model` e
`invoke_model_with_response_stream`. Em streaming o span só fecha depois que o
`usage` chega no evento `metadata` — é de lá que saem tokens e custo.

## Servidor MCP

Um MCP não tem modelo próprio: a unidade observável é a chamada de tool. Use
`kind: mcp` no manifesto e instrumente **antes** de registrar as tools.

```python
server = pump.instrument_mcp_server(seu_servidor)
```

Cobre as duas formas do pacote `mcp`, nas duas majors:

| Servidor | Como registra tools | O que é embrulhado |
| --- | --- | --- |
| `FastMCP` (1.x) / `MCPServer` (2.x) | `@server.tool()` e `add_tool(fn, ...)` | a função de cada tool |
| `Server` de baixo nível | `@server.call_tool()` (1.x) · `add_request_handler("tools/call", ...)` (2.x) | o despacho, com um span por tool servida |

A identidade da função é preservada, então nome, descrição e `inputSchema`
continuam saindo corretos.

**Servidor de formato desconhecido faz `instrument_mcp_server` lançar**, em vez
de devolvê-lo intacto. Nenhum span sairia dali, e falhar no boot é melhor que um
processo se dizendo instrumentado sem estar. (Com o SDK desabilitado nada disso
acontece: o handle no-op devolve o servidor sem tocar.) Nesse caso, embrulhe
cada handler na mão:

```python
from pump_evolution import McpToolInvocation

pump.trace_mcp_tool(
    McpToolInvocation(name=nome, input=json.dumps(args)),
    lambda: executa(nome, args),
)
```

Uma tool fora do `allowedTools` gera finding de compliance (`TOOL_NOT_ALLOWED`);
input com segredo ou PII gera finding de segurança. Observa, não bloqueia — e os
findings carregam só o rótulo da regra, nunca o valor sensível.

## Identidade do chamador

`run_with_identity` valida o Bearer do Cognito (JWKS RS256, issuer/audience/
expiração, fail-closed) e roda a função já dentro do contexto de identidade —
todo span daquele fluxo sai com `enduser.id` e `cta.department`, que é o que
sustenta o custo por departamento no portal.

```python
from pump_evolution import ConsumerTokenVerifier

auth = ConsumerTokenVerifier(issuer=os.environ["CTA_AUTH_ISSUER"])

resultado = await auth.run_with_identity(
    request.headers.get("authorization"),
    lambda user: trata_requisicao(user),
)
if not resultado.ok:
    return unauthorized(resultado.reason)
```

Sem um framework web na frente, use `with_user` direto:

```python
from pump_evolution import UserContext

pump.with_user(
    UserContext(user_id="alice@acme.com", department="engineering"),
    lambda: roda_o_agente(),
)
```

## Desligar

```python
await pump.shutdown()
```

Faz flush dos spans pendentes com timeout — telemetria não segura o shutdown do
processo.

## Validar antes de declarar pronto

O SDK degrada em silêncio por design no caminho de runtime: "o processo não
caiu" **não** é evidência de que a telemetria chegou. Suba com
`PUMP_EVOLUTION_ENABLED=true` e credenciais reais, faça uma invocação e confirme
o span no portal. Passe um `logger` no `PumpConfig` para ver falhas de export
(401, 403, 5xx) que de outro modo se perdem.

## Desenvolvimento

```bash
pip install "./py[dev]"
python -m pytest py/tests -q
```

Os testes de MCP rodam contra o pacote `mcp` real, não contra um duplo — duplo
só confirma o formato que você imaginou. Ver `AGENTS.md` na raiz do repositório.
