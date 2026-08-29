# pump-evolution — SDK de telemetria governada (Control Tower AI)

Pacote distribuído como vendor zip (sem npm/PyPI público).

## Você é um agente de IA (Kiro, Claude Code, Cursor)?

Leia **[`onboarding/PROMPT_AGENTE.md`](./onboarding/PROMPT_AGENTE.md)** e siga
aquilo. É a instrução completa: o que descobrir sozinho no código, o que
**perguntar ao humano em vez de inventar**, a ordem de instalação e como
validar de verdade — porque "subiu sem erro" não significa que a telemetria
está chegando.

Não improvise a partir só deste arquivo. As armadilhas que fazem a telemetria
sumir em silêncio estão documentadas lá, e nenhuma delas dá erro na hora.

## Instalação

### Node / TypeScript
```
npm install ./node/topaz-ia-pump-evolution-0.0.2.tgz
```

### Python
```
pip install ./python/src
```

## Configuração

O `CLIENT_SECRET` **nunca** vem no zip — pegue na aba SDK & Telemetria do
componente, no portal:

- `PUMP_EVOLUTION_ENABLED=true`
- `PUMP_SERVICE_ACCOUNT_CLIENT_ID` (do manifesto do agente/conector)
- `PUMP_SERVICE_ACCOUNT_CLIENT_SECRET` (Secrets Manager em produção)
- `PUMP_SERVICE_ACCOUNT_TOKEN_URL` e `otelEndpoint` (de `runtime.telemetry`)

Esses valores mudam por ambiente. Copiar de outro projeto ou deduzir a URL faz
a telemetria ir para a conta errada — o que não dá erro, só nunca aparece no
portal.

## Mais

- `README.md` — uso completo da biblioteca
- `onboarding/` — checklist, lições aprendidas e guia de integração
