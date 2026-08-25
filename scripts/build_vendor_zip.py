#!/usr/bin/env python3
"""Monta o vendor zip do pump-evolution — o artefato que a plataforma serve
em GET /api/sdk/download.

O SDK nao esta no npm nem no PyPI publico: e distribuido como zip no S3
(ADR-0055/0057). Ate 25/08/2026 esse zip era montado a mao, e por isso ficou
a frente do repositorio — havia codigo e documentacao que so existiam dentro
dele. Este script existe para que isso nao se repita: o zip passa a ser
derivado do repositorio, de forma reproduzivel.

Estrutura produzida (identica a que esta em producao):

    pump-evolution/
      CHANGELOG.md  INSTALL.md  README.md  SKILL.md  .env.example
      node/topaz-ia-pump-evolution-<versao>.tgz
      python/src/pyproject.toml
      python/src/pump_evolution/*.py

Uso:
    python scripts/build_vendor_zip.py                     # monta em dist-zip/
    python scripts/build_vendor_zip.py --skip-build        # reaproveita o .tgz existente
    python scripts/build_vendor_zip.py --compare ref.zip   # confere contra um zip de referencia

Sai com codigo != 0 em qualquer inconsistencia. Sem fallback silencioso: e
preferivel nao publicar a publicar um artefato torto (ADR-0031).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SAIDA = RAIZ / "dist-zip"
PREPARO = SAIDA / "pump-evolution"
NOME_ZIP = "pump-evolution-latest.zip"

# Documentos que acompanham o pacote. O integrador recebe isto junto com o
# codigo — sem eles, o onboarding vira descoberta por tentativa e erro.
DOCS = ["CHANGELOG.md", "INSTALL.md", "README.md", "SKILL.md", ".env.example"]

# Material de integracao produzido no onboarding do primeiro agente externo.
# Vai DENTRO do pacote de proposito: sem ele, quem baixa o SDK recebe a
# biblioteca e descobre o resto por tentativa e erro -- que foi exatamente o que
# custou uma manha de trabalho e originou estes arquivos.
ONBOARDING = "onboarding"

# Data fixa nas entradas do zip. Sem isto, dois builds do mesmo commit geram
# arquivos diferentes e qualquer comparacao vira ruido.
DATA_FIXA = (2026, 1, 1, 0, 0, 0)


# Extensoes tratadas como texto: copiadas com LF, sempre. Sem isto o zip sai
# diferente conforme o sistema de quem monta -- um clone Windows converte para
# CRLF no checkout, e o artefato deixaria de ser reproduzivel.
TEXTO = {".md", ".py", ".toml", ".example", ".yaml", ".yml", ".json"}


def copiar(origem: Path, destino: Path) -> None:
    if origem.suffix in TEXTO or origem.name == ".env.example":
        destino.write_bytes(origem.read_bytes().replace(b"\r\n", b"\n"))
    else:
        shutil.copyfile(origem, destino)


def erro(msg: str) -> None:
    print(f"ERRO: {msg}", file=sys.stderr)
    raise SystemExit(1)


def versao_do_package() -> str:
    dados = json.loads((RAIZ / "package.json").read_text(encoding="utf-8"))
    return dados["version"]


def versao_do_pyproject() -> str:
    texto = (RAIZ / "py" / "pyproject.toml").read_text(encoding="utf-8")
    achado = re.search(r'^version\s*=\s*"([^"]+)"', texto, re.M)
    if not achado:
        erro("py/pyproject.toml nao declara version")
    return achado.group(1)


def versao_do_user_agent() -> str | None:
    """O SDK_USER_AGENT viaja em todo request ao receiver. Se ele mentir a
    versao, o diagnostico de producao aponta para o codigo errado."""
    texto = (RAIZ / "src" / "otlp-exporter.ts").read_text(encoding="utf-8")
    achado = re.search(r'SDK_USER_AGENT\s*=\s*"[^"]*/([^"/]+)"', texto)
    return achado.group(1) if achado else None


def conferir_versoes() -> str:
    pkg, py, ua = versao_do_package(), versao_do_pyproject(), versao_do_user_agent()
    print(f"  package.json      {pkg}")
    print(f"  py/pyproject.toml {py}")
    print(f"  SDK_USER_AGENT    {ua or '(nao encontrado)'}")

    divergentes = {v for v in (pkg, py, ua) if v is not None}
    if len(divergentes) > 1:
        erro(
            "as versoes declaradas nao batem entre si. Publicar assim gera um "
            "artefato que mente sobre a propria versao — corrija antes de montar."
        )
    return pkg


def montar_tgz(pular_build: bool) -> Path:
    """Gera o tarball npm com o build do TypeScript."""
    if not pular_build:
        for comando in (["pnpm", "run", "build"], ["npm", "pack"]):
            print(f"  $ {' '.join(comando)}")
            r = subprocess.run(comando, cwd=RAIZ, shell=(sys.platform == "win32"))
            if r.returncode != 0:
                erro(f"{' '.join(comando)} falhou com codigo {r.returncode}")

    achados = sorted(RAIZ.glob("topaz-ia-pump-evolution-*.tgz"))
    if not achados:
        erro(
            "nenhum .tgz encontrado na raiz. Rode sem --skip-build, ou gere o "
            "tarball com `npm pack` antes."
        )
    if len(achados) > 1:
        erro(f"mais de um .tgz na raiz ({[a.name for a in achados]}) — remova os antigos")
    return achados[0]


def preparar(versao: str, tgz: Path) -> None:
    if SAIDA.exists():
        shutil.rmtree(SAIDA)
    PREPARO.mkdir(parents=True)

    for nome in DOCS:
        origem = RAIZ / nome
        if not origem.exists():
            erro(f"{nome} nao existe no repositorio — o pacote nao pode sair sem ele")
        copiar(origem, PREPARO / nome)

    origem_onb = RAIZ / ONBOARDING
    if not origem_onb.is_dir():
        erro(
            f"{ONBOARDING}/ nao existe no repositorio. O pacote nao pode sair sem o "
            "material de integracao -- e ele que evita que cada onboarding vire "
            "descoberta por tentativa e erro."
        )
    destino_onb = PREPARO / ONBOARDING
    destino_onb.mkdir()
    for arquivo in sorted(origem_onb.iterdir()):
        if arquivo.is_file():
            copiar(arquivo, destino_onb / arquivo.name)
    print(f"  onboarding: {len(list(destino_onb.iterdir()))} arquivos")

    (PREPARO / "node").mkdir()
    shutil.copyfile(tgz, PREPARO / "node" / tgz.name)

    # py/ no repositorio vira python/src/ no pacote: o pyproject usa
    # `where = ["."]`, entao ele precisa ficar ao lado de pump_evolution/.
    destino_py = PREPARO / "python" / "src"
    destino_py.mkdir(parents=True)
    copiar(RAIZ / "py" / "pyproject.toml", destino_py / "pyproject.toml")
    (destino_py / "pump_evolution").mkdir()
    for modulo in sorted((RAIZ / "py" / "pump_evolution").glob("*.py")):
        copiar(modulo, destino_py / "pump_evolution" / modulo.name)
    print(f"  preparo montado em {PREPARO.relative_to(RAIZ)} (versao {versao})")


def escrever_zip() -> Path:
    """Zip deterministico: entradas ordenadas e data fixa."""
    caminho = SAIDA / NOME_ZIP
    arquivos = sorted(p for p in PREPARO.rglob("*") if p.is_file())
    with zipfile.ZipFile(caminho, "w", zipfile.ZIP_DEFLATED) as z:
        for arquivo in arquivos:
            interno = arquivo.relative_to(SAIDA).as_posix()
            info = zipfile.ZipInfo(interno, date_time=DATA_FIXA)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, arquivo.read_bytes())
    print(f"  {caminho.name}: {caminho.stat().st_size:,} bytes, {len(arquivos)} arquivos")
    return caminho


def comparar(gerado: Path, referencia: Path) -> None:
    """Confere o zip gerado contra um de referencia, entrada por entrada.

    Timestamps e ordem interna sao ignorados de proposito: o que importa e o
    conteudo. Diferenca real e reportada e faz o script falhar — publicar por
    cima do artefato de producao sem entender a diferenca ja custou caro aqui.
    """
    def conteudo(p: Path) -> dict[str, bytes]:
        with zipfile.ZipFile(p) as z:
            return {
                i.filename: z.read(i.filename)
                for i in z.infolist()
                if not i.is_dir()
            }

    a, b = conteudo(gerado), conteudo(referencia)
    so_gerado = sorted(set(a) - set(b))
    so_ref = sorted(set(b) - set(a))
    difere = sorted(k for k in set(a) & set(b) if a[k] != b[k])

    print(f"  entradas: gerado {len(a)} | referencia {len(b)}")
    for nome in so_gerado:
        print(f"    + so no gerado:      {nome}")
    for nome in so_ref:
        print(f"    - so na referencia:  {nome}")
    for nome in difere:
        print(f"    ~ conteudo difere:   {nome} ({len(b[nome])} -> {len(a[nome])} bytes)")

    if so_gerado or so_ref or difere:
        erro(
            "o zip gerado difere da referencia. Entenda cada diferenca antes de "
            "publicar — o artefato em producao e o que os integradores ja usam."
        )
    print("  identico a referencia")


def main() -> None:
    p = argparse.ArgumentParser(description="Monta o vendor zip do pump-evolution")
    p.add_argument("--skip-build", action="store_true", help="reaproveita o .tgz ja existente")
    p.add_argument("--compare", metavar="ZIP", help="confere contra um zip de referencia")
    args = p.parse_args()

    print("Versoes")
    versao = conferir_versoes()

    print("Tarball npm")
    tgz = montar_tgz(args.skip_build)
    print(f"  {tgz.name}")

    print("Preparo")
    preparar(versao, tgz)

    print("Zip")
    gerado = escrever_zip()

    if args.compare:
        print("Comparacao")
        referencia = Path(args.compare)
        if not referencia.exists():
            erro(f"zip de referencia nao encontrado: {referencia}")
        comparar(gerado, referencia)


if __name__ == "__main__":
    main()
