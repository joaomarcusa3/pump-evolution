# Lições Aprendidas — Integração pump-evolution

## 1. O CTA aceita APENAS spans com `gen_ai.operation.name = "chat"`

- Span name `invoke_model` → `accepted: 0` (descartado)
- Span name `execute_tool` → `accepted: 0` (descartado)
- Span name `chat` + atributo `gen_ai.operation.name = "chat"` → `accepted: 1`

O `instrument_bedrock()` do SDK já emite no formato correto. Pra providers
manuais, SEMPRE setar `gen_ai.operation.name = "chat"`.

## 2. Dois Cognitos, zero conflito

O agente pode usar QUALQUER Cognito/IdP pro login dos seus usuários.
O SDK usa um service account M2M separado (Cognito do CTA) só pra enviar telemetria.
Nunca precisamos federar, criar trust, ou mudar configuração em nenhum pool.

```
Cognito do Agente → autentica o USUÁRIO (login/SSO)
Cognito do CTA    → autentica a MÁQUINA (service account M2M)
```

## 3. Department vem do id_token, não do grupo interno

O `group_name` do app (ex: "Administrador") é o grupo de ACESSO interno.
O `custom:department` no id_token do Cognito é o departamento REAL do usuário.
O middleware lê o JWT guardado, decodifica (sem validar — já foi validado no login)
e extrai os claims custom.

Claims suportados:
- `custom:department` ou `custom:topaz_directorate` → `cta.department`
- `custom:cost_center` ou `custom:cta_cost_center` → `cta.cost_center`

## 4. HTTP 202 com `accepted: 0` = span descartado silenciosamente

O receiver aceita o request (auth OK, payload válido) mas descarta o span
se não reconhece o formato. Usar o logger do SDK pra diagnosticar:

```python
pump = PumpEvolution.init(PumpConfig(..., logger=MyLogger()))
```

## 5. O `modelId` no manifest é estático — invocações reais são dinâmicas

O campo `modelId` no manifest é obrigatório pra `kind: agent` (resource attribute
fixo). Mas o modelo REAL de cada chamada é reportado individualmente no span
via `gen_ai.request.model` (lido do `modelId` do Converse/invoke).

Agentes multi-modelo: coloque o modelo mais usado no manifest.

## 6. O SDK é NO-OP sem `PUMP_EVOLUTION_ENABLED=true`

Se a variável não está setada ou é diferente de "true", o SDK retorna um
`_NoopHandle` que não faz nada — zero overhead, zero risco.

## 7. `.env.pump` NUNCA no git

O `.gitignore` do projeto deve ter:
```
.env
.env.*
!.env.*.template
```

O secret vive no Secrets Manager ou é entregue via canal seguro.

## 8. Deploy reproduzível requer vendor no git

O SDK não está no PyPI — é distribuído como vendor. Pra deploy ser
reproduzível sem intervenção manual:
- Vendor no repo (`backend/vendor/pump_evolution/`)
- Referência no requirements: `./vendor/`
- Dockerfile copia vendor antes do `pip install`

## 9. EC2 em subnet privada pode não alcançar o endpoint

Se a EC2 não tem rota pra internet ou pro CloudFront do CTA,
o export falha silenciosamente. Verificar conectividade:
```bash
curl -X POST <otelEndpoint — pegue na aba SDK & Telemetria do componente> \
  -H "Content-Type: application/json" -d '{}'
# Deve retornar 401 (auth missing) — significa que alcançou
```

## 10. WAF bloqueia requests sem User-Agent

Testes manuais com scripts Python/Node puro podem ser bloqueados pelo WAF
(regra `NoUserAgent_HEADER`). O SDK real já manda User-Agent — é só
pegadinha em scripts ad-hoc de teste.
