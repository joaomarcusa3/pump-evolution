# Onboarding — instrumentar um serviço com o pump-evolution

Material para levar um serviço qualquer — agente ou conector MCP, em Python ou
Node, dentro ou fora da AWS — a reportar telemetria governada ao Control Tower
AI.

Nasceu do primeiro onboarding real, em agosto de 2026, quando cada armadilha
aqui listada foi encontrada na marra. Mas nada aqui é específico daquele
serviço: os endpoints são parâmetros, e o código que era para copiar virou
módulo do pacote.

## Se você é um agente de IA

Comece por **[`PROMPT_AGENTE.md`](./PROMPT_AGENTE.md)**. Ele é a instrução
completa: o que descobrir sozinho, o que perguntar ao humano em vez de
inventar, a ordem de instalação e como validar de verdade.

## Se você é uma pessoa

| Arquivo | Para quê |
| --- | --- |
| [`PROMPT_AGENTE.md`](./PROMPT_AGENTE.md) | Entregue a um Kiro/Claude/Cursor junto com o zip e as credenciais |
| [`CHECKLIST_ONBOARDING.md`](./CHECKLIST_ONBOARDING.md) | Passo a passo de ponta a ponta, incluindo o que **não** precisa ser feito |
| [`LICOES_APRENDIDAS.md`](./LICOES_APRENDIDAS.md) | As dez armadilhas encontradas na prática, com o sintoma de cada uma |
| [`GUIA_INTEGRACAO.md`](./GUIA_INTEGRACAO.md) | Guia Python/FastAPI, com os trechos de código |
| [`manifest.template.yaml`](./manifest.template.yaml) | Template do manifesto do serviço |

## O que você precisa ter em mãos

Tudo isto sai da aba **SDK & Telemetria** do componente, no portal:

- `canonical_name` do componente registrado
- `otelEndpoint` — o receiver **da conta onde o componente vive**
- `serviceAccountId` (client_id) e o client_secret, com escopo `telemetry:write`
- `tokenUrl` — endpoint OAuth do Cognito da plataforma

Nenhum desses valores deve ser deduzido ou copiado de outro projeto. Eles mudam
por ambiente, e apontar para o lugar errado não dá erro — só telemetria que
nunca chega.

## O que mudou na 0.0.2

Três coisas que este material pedia deixaram de ser trabalho manual:

- **`record_chat()`** — providers fora do Bedrock deixam de exigir ~30 linhas
  de span montado à mão. Era ali que nascia o `accepted: 0`.
- **`pump_evolution.integrations.fastapi`** — o middleware de identidade virou
  módulo importável. O arquivo solto que existia aqui foi removido: não há mais
  nada para copiar e adaptar.
- **O logger reporta o veredito do receiver** — quando o lote é aceito e
  descartado, o SDK passa a dizer, em vez de deixar tudo parecendo bem.

Os textos ainda descrevem os caminhos antigos em alguns pontos, para explicar
*por que* as coisas são como são. Onde houver divergência, o código do pacote
manda.
