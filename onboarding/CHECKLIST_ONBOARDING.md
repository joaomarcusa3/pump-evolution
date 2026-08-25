# Checklist de Onboarding — pump-evolution SDK

## 1. Pré-requisitos (plataforma CTA)

- [ ] Registrar o agente no portal CTA (formulário de novo componente)
- [ ] Obter `canonical_name` e `registry_id`
- [ ] Gerar service account (client credentials) — portal gera automaticamente
- [ ] Revelar secret na página do componente (nunca aparece no chat/log)
- [ ] Anotar: `client_id`, `client_secret`, `token_url`, `otel_endpoint`

## 2. Discovery do agente (perguntar ao dono)

- [ ] **Stack:** Python ou Node.js?
- [ ] **Framework web:** FastAPI, Express, Flask, etc.?
- [ ] **Onde guarda o usuário logado?** (`request.state.user`, `req.user`, sessão, etc.)
- [ ] **Onde guarda o id_token/JWT do login?** (banco, memória, cookie, Setting)
- [ ] **Usa Bedrock?** Direto ou via LangChain?
- [ ] **Usa outros providers?** (SAI, OpenAI, Anthropic direto)
- [ ] **Tem graceful shutdown?** (SIGTERM handler, evento de shutdown)
- [ ] **Qual Cognito/IdP usa?** (não precisa mudar — só saber pra mapear claims)

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
- [ ] Inserir middleware de identidade (lê id_token → extrai claims)
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

## 6. O que NÃO precisa fazer

- ❌ Federar Cognitos entre agente e CTA
- ❌ Mudar o auth/login do agente
- ❌ Criar usuários no Cognito do CTA
- ❌ Registrar o agente no Cognito do CTA (só o service account M2M)
- ❌ Modificar claims no Cognito do agente
