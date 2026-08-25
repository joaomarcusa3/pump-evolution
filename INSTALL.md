# pump-evolution — SDK de telemetria governada (Control Tower AI)

Pacote distribuído como vendor zip (sem npm/PyPI público).

## Node / TypeScript
```
npm install ./node/topaz-ia-pump-evolution-0.0.2.tgz
```

## Python
```
pip install ./python/src
```

Configuração via env (o CLIENT_SECRET NUNCA vem no zip — pegue na Página de Apoio do portal):
- PUMP_EVOLUTION_ENABLED=true
- PUMP_SERVICE_ACCOUNT_CLIENT_ID (do manifesto do agente/conector)
- PUMP_SERVICE_ACCOUNT_CLIENT_SECRET (Secrets Manager / Página de Apoio)
- PUMP_TOKEN_URL, otelEndpoint (do manifesto runtime.telemetry)

Ver README.md para uso completo.
