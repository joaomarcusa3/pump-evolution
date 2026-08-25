# Kit de onboarding — pump-evolution

Material de integração produzido durante o onboarding real de um agente externo
(SuperDoc Consórcio, agosto/2026). Trazido para o repositório **sem alteração**:
os arquivos são cópia byte a byte do que foi usado em produção.

## Por que isto está aqui

Até agora este material vivia apenas na máquina de quem fez o onboarding. O SDK
publicado entrega a biblioteca, mas não o caminho de integração — descobrir que o
span precisa de `gen_ai.operation.name = "chat"`, que `202` com `accepted: 0` é
descarte silencioso, ou que `department` vem do `id_token` e não do grupo interno
custou uma manhã de tentativa e erro. Este diretório existe para que a próxima
integração não repita esse custo.

Leia como **registro do que foi necessário**, não como especificação do que o SDK
já faz.

## Conteúdo

| Arquivo | O que é |
| --- | --- |
| [`CHECKLIST_ONBOARDING.md`](./CHECKLIST_ONBOARDING.md) | Passo a passo de ponta a ponta, incluindo o que **não** precisa ser feito |
| [`LICOES_APRENDIDAS.md`](./LICOES_APRENDIDAS.md) | Dez armadilhas encontradas na prática, com o sintoma de cada uma |
| [`GUIA_INTEGRACAO.md`](./GUIA_INTEGRACAO.md) | Guia de integração Python/FastAPI, com os trechos de código |
| [`middleware_fastapi.py`](./middleware_fastapi.py) | Middleware de identidade pronto para copiar e adaptar |
| [`manifest.template.yaml`](./manifest.template.yaml) | Template do manifesto do agente |

## Ressalvas importantes

**Estes arquivos não são o estado desejado.** Vários deles existem porque o SDK
ainda não cobre o caso:

- `middleware_fastapi.py` é código que cada integrador copia e adapta. Deveria ser
  um módulo do pacote (`pump_evolution.integrations.fastapi`), importável e testado.
  Como está, ele carrega imports específicos da aplicação de origem
  (`src.db.models.Setting`) que **não funcionam** em outro projeto sem edição.
- A seção 5.2 do guia descreve ~30 linhas de span manual para todo provider que não
  seja Bedrock. É aí que nasce o `accepted: 0`: basta esquecer um atributo. Deveria
  ser uma chamada do SDK.
- O `manifest.template.yaml` traz o endpoint de telemetria fixo no valor de um
  ambiente específico. O endpoint correto varia por conta e é derivado pela
  plataforma — o template não deveria fixá-lo.

**Falta um arquivo.** O kit original inclui um `.env.pump.template`. Ele não foi
trazido nesta MR: o ambiente de quem preparou o commit bloqueia leitura de arquivos
`.env*`, e um arquivo não lido não deve ser publicado. O conteúdo aparece
reproduzido na seção 3 do `GUIA_INTEGRACAO.md`. Adicione-o em commit próprio depois
de confirmar que não há segredo real dentro.

**Os valores de exemplo apontam para uma conta específica.** Endpoints e domínios
Cognito citados nos documentos são do ambiente onde o onboarding aconteceu. Confira
os valores da sua conta na página do componente no portal antes de copiar.
