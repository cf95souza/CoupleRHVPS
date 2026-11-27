# Guia Prático de Preenchimento — Planilhas de Implantação e Histórico 2026 (coupleRH)

Este guia orienta o **RH / Departamento Pessoal** no preenchimento das **6 planilhas modelo** para importar o histórico de **Janeiro/2026 até a data da virada** (proveniente do sistema antigo descontinuado) e garantir que **13º Salário (1ª parcela, 2ª parcela e parcela única), Férias, Banco de Horas, Afastamentos e Informe de Rendimentos 2026** funcionem perfeitamente no **coupleRH**.

---

## 1. Lista de Planilhas e Ordem de Preenchimento

| Ordem | Arquivo Modelo | Para que serve | Obrigatória? |
|---|---|---|---|
| **1º** | [`01_colaboradores_contratos_dependentes.csv`](./01_colaboradores_contratos_dependentes.csv) | Cadastro base de colaboradores, matrículas, salários, dados bancários e quantidade de dependentes | **Sim** (se ainda não cadastrados no sistema) |
| **2º** | [`02_historico_folha_2026_ficha_financeira.csv`](./02_historico_folha_2026_ficha_financeira.csv) | Ficha financeira mês a mês de Jan/2026 até a virada: salários, horas extras, adicionais, **faltas**, atrasos, descontos, INSS, IRRF, FGTS e adiantamentos de 13º | **Sim** (essencial para médias de 13º/férias, avos e Informe 2026) |
| **3º** | [`03_saldos_ferias_periodos_aquisitivos.csv`](./03_saldos_ferias_periodos_aquisitivos.csv) | Períodos aquisitivos em aberto ou em andamento, dias já gozados/vendidos e faltas acumuladas (Art. 130 CLT) | **Sim** (para quem já tem contrato ativo antes da virada) |
| **4º** | [`04_afastamentos_2026_e_em_curso.csv`](./04_afastamentos_2026_e_em_curso.csv) | Afastamentos médicos (> 15d ou mesma CID 60d), licenças-maternidade e acidentes de trabalho ocorridos em 2026 ou ainda ativos | **Sim**, se houve afastamentos em 2026 |
| **5º** | [`05_saldo_inicial_banco_de_horas.csv`](./05_saldo_inicial_banco_de_horas.csv) | Saldo acumulado (positivo ou negativo) do banco de horas na data de corte | **Sim**, se a empresa usa Banco de Horas |
| **6º** | [`06_emprestimos_consignados_e_debitos_anteriores.csv`](./06_emprestimos_consignados_e_debitos_anteriores.csv) | Empréstimos consignados em andamento (com parcelas já pagas) e eventuais saldos devedores de folha anterior (`899`) | **Sim**, se houver empréstimos/débitos em curso |

---

## 2. Regras de Ouro para Editar no Excel sem Erros

1. **Apague as linhas de `EXEMPLO` antes de enviar** (mantenha sempre a **1ª linha de cabeçalho** intacta, sem renomear nem trocar a ordem das colunas).
2. **Como abrir no Excel sem estragar CPF, PIS e CBO (zeros à esquerda):**
   - Os arquivos já estão em **UTF-8 com BOM** e separador **ponto e vírgula (`;`)** — ao dar duplo clique no Excel em português, as colunas já abrem separadas.
   - Se o Excel remover zeros à esquerda de `cpf_colaborador` (11 dígitos) ou `cbo` (6 dígitos), formate a coluna como **Texto** antes de colar os dados do sistema antigo, ou use **Dados → De Texto/CSV** selecionando tipo *Texto* para colunas de código/documento.
   - O sistema aceitará **CPF com ou sem pontuação** (`11122233344` ou `111.222.333-44`) e preencherá automaticamente zeros à esquerda se faltarem, desde que conferido no Dry-Run.
3. **Formato de Datas:** preferencialmente `AAAA-MM-DD` (ex.: `2026-01-15`).
4. **Formato de Valores e Quantidades:** preferencialmente ponto decimal (`1250.50`, `12.50`), **sem símbolo `R$`** e **sem separador de milhar** (o importador também aceitará vírgula decimal brasileira `1250,50`, desde que sem ponto de milhar misturado).
5. **Salvar como CSV UTF-8:** no Excel, use **Salvar Como → `CSV UTF-8 (Delimitado por vírgulas) (*.csv)`**.

---

## 3. Tabela Oficial de Rubricas (`codigo_rubrica_couplerh`) para a Planilha 02

Na planilha [`02_historico_folha_2026_ficha_financeira.csv`](./02_historico_folha_2026_ficha_financeira.csv), preencha **`codigo_rubrica_legado`** com o código do seu sistema antigo e **`codigo_rubrica_couplerh`** com o código correspondente abaixo.

> **ATENÇÃO ESPECIAL ÀS QUANTIDADES (`quantidade_referencia`):**
> - Para **Horas Extras e Adicional Noturno**, informe **obrigatoriamente a quantidade em HORAS** (ex.: `12.50` para 12h30min) em `quantidade_referencia`, além do valor em reais pago no mês em `valor_reais`. É essa quantidade física de horas que garante o cálculo legal das médias pela **Súmula 347 do TST** (valorizadas pelo salário-hora atual no 13º e nas férias).
> - Para **Faltas Injustificadas (`801`)**, informe **obrigatoriamente a quantidade em DIAS** (ex.: `2.00` ou `16.00`) em `quantidade_referencia`, pois mais de 15 faltas no mês fazem perder o avo do 13º salário e reduzem dias de férias (Art. 130 CLT).

### 3.1 Proventos (`tipo_evento = EARNING`)

| Código coupleRH | Descrição Oficial | Unidade (`unidade_referencia`) | Entra na Média 13º / Férias? |
|---|---|---|---|
| `101` | Salário Base Contratual | `DIAS` | Não (é a base fixa) |
| `102` | Horas Extras 50% | `HORAS` | **Sim (Média Física de Horas)** |
| `103` | Horas Extras 100% | `HORAS` | **Sim (Média Física de Horas)** |
| `104` | Salário-Maternidade | `DIAS` | Não |
| `105` | Auxílio-Doença (15 primeiros dias empresa) | `DIAS` | Não |
| `106` | Adicional por Tempo de Serviço (ATS / Anuênio / Quinquênio) | `VALOR` | Fixo habitual |
| `107` | Diferença de Piso Salarial CCT | `VALOR` | Fixo habitual |
| `108` | Hora Extra Noturna 50% (OJ 97 TST) | `HORAS` | **Sim (Média Física de Horas)** |
| `109` | Hora Extra Noturna 100% (OJ 97 TST) | `HORAS` | **Sim (Média Física de Horas)** |
| `124` | Adicional de Sobreaviso (1/3) | `HORAS` | Sim, se habitual |
| `125` | Adicional de Prontidão (2/3) | `HORAS` | Sim, se habitual |
| `150` | Adicional de Insalubridade | `VALOR` | Fixo habitual |
| `151` | Adicional de Periculosidade | `VALOR` | Fixo habitual |
| `250` | Adiantamento Salarial (Vale Quinzenal) | `VALOR` | Não (usar `tipo_folha = ADVANCE`) |
| `301` | Adicional Noturno 20% | `HORAS` | **Sim (Média Física de Horas)** |
| `305` | Salário-Família | `VALOR` | Não (isento — Quadro 4 Informe) |
| `401` | DSR sobre Horas Extras | `VALOR` | **Sim (Média Monetária)** |
| `402` | DSR sobre Adicional Noturno | `VALOR` | **Sim (Média Monetária)** |
| `601` | 13º Salário — 1ª Parcela (ou Adiant. 13º nas Férias) | `AVOS` | Não (será abatido na 2ª parcela) |
| `602` | 13º Salário — 2ª Parcela | `AVOS` | Não |
| `701` | Férias Gozadas no Mês | `DIAS` | Não |
| `702` | 1/3 Constitucional de Férias | `VALOR` | Não |
| `703` | Abono Pecuniário de Férias | `DIAS` | Não (isento) |
| `704` | 1/3 Constitucional do Abono Pecuniário | `VALOR` | Não (isento) |

### 3.2 Descontos (`tipo_evento = DEDUCTION`)

| Código coupleRH | Descrição Oficial | Unidade (`unidade_referencia`) | Observação |
|---|---|---|---|
| `801` | Faltas Injustificadas | `DIAS` | **Crítico para avos de 13º e redução de férias** |
| `802` | DSR sobre Faltas | `DIAS` | Desconto de DSR perdido por falta |
| `803` | Atrasos e Saídas Antecipadas | `HORAS` | Horas não trabalhadas descontadas |
| `805` | Empréstimo Consignado | `VALOR` | Parcela descontada no mês |
| `850` | Desconto de Adiantamento Salarial | `VALOR` | Baixa do vale quinzenal na folha mensal |
| `901` | Contribuição INSS | `VALOR` | INSS retido (alimenta Informe de Rendimentos) |
| `902` | IRRF Mensal | `VALOR` | IRRF retido (alimenta Regime de Caixa / Informe) |
| `904` | Pensão Alimentícia Judicial | `VALOR` | Pensão retida (alimenta Quadros 3 e 7 RFB) |
| `905` | Desconto Vale-Transporte (6%) | `VALOR` | Desconto de VT |
| `907` | Desconto Plano de Saúde — Titular | `VALOR` | Alimenta Quadro 7 Informe de Rendimentos |
| `908` | Desconto Plano de Saúde — Dependentes | `VALOR` | Alimenta Quadro 7 Informe de Rendimentos |
| `909` | Coparticipação Plano de Saúde | `VALOR` | Alimenta Quadro 7 Informe de Rendimentos |
| `910` | Desconto Plano Odontológico | `VALOR` | — |
| `911` | Coparticipação Plano Odontológico | `VALOR` | — |
| `912` | Desconto PAT Alimentação / Refeição | `VALOR` | VA / VR |

### 3.3 Informativas (`tipo_evento = NEUTRAL`)

| Código coupleRH | Descrição Oficial | Unidade | Observação |
|---|---|---|---|
| `903` | FGTS Mensal do Empregado | `VALOR` | Valor de FGTS apurado sobre a folha (especialmente importante quando houve `601` 1ª parcela do 13º) |

> **Dica para rubricas próprias da empresa** (ex.: Comissões, Prêmios, Quebra de Caixa, Seguro de Vida, Farmácia): mantenha o código do sistema antigo em `codigo_rubrica_legado`, descreva claramente em `descricao_rubrica` e deixe `codigo_rubrica_couplerh` em branco ou com o código da rubrica customizada criada no cadastro — o assistente de importação exibirá a tela de **De-Para de Rubricas** antes de concluir.

---

## 4. Valores Válidos para Campos Controlados

- **`tipo_folha` (Planilha 02):** `MONTHLY` (Mensal), `ADVANCE` (Adiantamento), `VACATION` (Férias — se pagou 13º `601` junto), `THIRTEENTH_1` (se já pagou 1ª parcela no antigo), `COMPLEMENTARY` (Complementar).
- **`regime_calculo` (Planilha 01):** `CLT`, `APPRENTICE` (Aprendiz), `HOURLY` (Horista), `DAILY` (Diarista), `COMMISSION_ONLY` (Comissionista Puro), `INTERMITTENT` (Intermitente), `INTERN` (Estagiário), `PRO_LABORE`, `AUTONOMOUS_RPA`.
- **`status` (Planilha 03 — Férias):** `OPEN` (Aberto/Disponível), `IN_PROGRESS` (Parcialmente gozado), `CLOSED` (Totalmente quitado), `FORFEITED` (Perdido por afastamento > 180d INSS).
- **`codigo_motivo_esocial` (Planilha 04 — Afastamentos Tabela 18):** `01` (Acidente do Trabalho), `03` (Auxílio-Doença não relacionado ao trabalho), `17` (Licença-Maternidade 120d), `21` (Licença sem remuneração), `29` (Serviço Militar).

---

## 5. Checklist de Conferência Antes de Enviar para Importação

- [ ] Todos os colaboradores ativos em 2026 (e eventuais demitidos em 2026 caso queiram emitir Informe 2026 pelo coupleRH) constam na Planilha 01;
- [ ] Todas as competências fechadas de **01/2026 até o mês anterior à virada** estão lançadas na Planilha 02;
- [ ] A soma de `EARNING` (proventos), `DEDUCTION` (descontos) e líquido por competência na Planilha 02 bate **centavo a centavo** com o **Resumo Geral de Folha** emitido no sistema descontinuado;
- [ ] Horas extras/noturnas estão com `quantidade_referencia` preenchida em **horas** e faltas (`801`) em **dias**;
- [ ] Todas as linhas `EXEMPLO` foram removidas dos arquivos finais.
