# Checklist de Onboarding — pump-evolution SDK

## 1. Pré-requisitos (plataforma CTA)

- [ ] Registrar o agente no portal CTA (formulário de novo componente)
- [ ] Obter `canonical_name` e `registry_id`
- [ ] Gerar service account (client credentials) — portal gera automaticamente
- [ ] Revelar secret na página do componente (nunca aparece no chat/log)
- [ ] Anotar: `client_id`, `client_secret`, `token_url`, `otel_endpoint`
- [ ] **Provisionar o Cognito de usuário na tooling** (App Client do agente, via
      Factory API, no install) — anotar `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`,
      `COGNITO_REDIRECT_URI` e, se confidencial, `COGNITO_CLIENT_SECRET`

## 2. Discovery do agente (perguntar ao dono)

- [ ] **Stack:** Python ou Node.js?
- [ ] **Framework web:** FastAPI, Express, Flask, etc.?
- [ ] **Onde guarda o usuário logado?** (`request.state.user`, `req.user`, sessão, etc.)
- [ ] **Tem `SessionMiddleware`/sessão?** (o login da tooling guarda state/PKCE e id_token na sessão)
- [ ] **Usa Bedrock?** Direto ou via LangChain?
- [ ] **Usa outros providers?** (SAI, OpenAI, Anthropic direto)
- [ ] **Tem graceful shutdown?** (SIGTERM handler, evento de shutdown)
- [ ] **Qual Cognito/IdP usa hoje?** O login troca para o Cognito de
      usuário da conta de tooling — saiba o login atual para planejar a troca das
      rotas `/auth/*`

## 3. Entregar ao agente

- [ ] SDK (`vendor/pump_evolution/` ou `.tgz` pra Node)
- [ ] `manifest.yaml` preenchido
- [ ] `.env.pump.template` (sem secret)
- [ ] `.env.pump` com secret real (via Secrets Manager ou entrega segura)
- [ ] Instruções de integração (`GUIA_INTEGRACAO.md`)

## 4. Integração (dev do agente)

- [ ] Instalar SDK (`pip install ./vendor/` ou `npm install ./tgz`)
- [ ] Colocar `manifest.yaml` na raiz do app
- [ ] Configurar `.env.pump` com credenciais
- [ ] Inserir imports + loader no entrypoint
- [ ] Inserir init no startup
- [ ] Trocar o login para o Cognito da tooling (`CognitoLogin` + rotas `/auth/*`)
- [ ] Inserir middleware de identidade (user_resolver + id_token_resolver do CognitoLogin)
- [ ] Instrumentar Bedrock (`pump.instrument_bedrock(client)`)
- [ ] Instrumentar outros providers (wrapper manual se necessário)
- [ ] Inserir shutdown handler
- [ ] Adicionar SDK no requirements/package.json (deploy reproduzível)
- [ ] Garantir Dockerfile copia vendor + manifest

## 5. Validação

- [ ] Container/app inicia sem erro
- [ ] Log mostra `[pump] SDK inicializado`
- [ ] Disparar uma chamada real ao modelo
- [ ] Portal CTA mostra `accepted: 1`
- [ ] `enduser.id` = email correto do usuário
- [ ] `cta.department` = departamento real (claim do Cognito, não grupo interno)
- [ ] `gen_ai.usage.input_tokens` > 0
- [ ] `gen_ai.request.model` = modelo correto

## 6. O que NÃO fazer

- ❌ Deixar o login do usuário no Cognito antigo do agente (o login precisa usar o
     pool da tooling — é ele que carrega os claims de custo governados)
- ❌ Federar o Cognito antigo do agente com o pool da tooling (é troca de login, não federação)
- ❌ Criar usuários manualmente no pool da tooling (o login é self-service via Hosted UI)
- ❌ Reusar o service account M2M de telemetria como login de usuário (ou o inverso)
- ❌ Commitar `.env.pump`, `client_secret` ou `COGNITO_CLIENT_SECRET`
