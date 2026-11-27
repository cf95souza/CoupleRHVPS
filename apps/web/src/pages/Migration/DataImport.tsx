import React, { useState, useEffect } from 'react';
import {
  Download,
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Clock,
  ShieldCheck,
  RefreshCw,
  Database,
  ArrowRight,
  BookOpen,
  Info,
  Calendar,
  Users,
  DollarSign,
  Check,
} from 'lucide-react';
import {
  migrationService,
  MigrationTemplateInfo,
  MigrationPreviewResult,
  MigrationExecuteResult,
} from '../../services/migration/migrationService';

export default function DataImport() {
  const [templates, setTemplates] = useState<MigrationTemplateInfo[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  // Arquivos em texto carregados pelo usuário
  const [workersCsvContent, setWorkersCsvContent] = useState<string>('');
  const [workersFileName, setWorkersFileName] = useState<string>('');
  const [historyCsvContent, setHistoryCsvContent] = useState<string>('');
  const [historyFileName, setHistoryFileName] = useState<string>('');
  const [vacationsCsvContent, setVacationsCsvContent] = useState<string>('');
  const [vacationsFileName, setVacationsFileName] = useState<string>('');
  const [leavesCsvContent, setLeavesCsvContent] = useState<string>('');
  const [leavesFileName, setLeavesFileName] = useState<string>('');
  const [timeBankCsvContent, setTimeBankCsvContent] = useState<string>('');
  const [timeBankFileName, setTimeBankFileName] = useState<string>('');
  const [loansAndDebtsCsvContent, setLoansAndDebtsCsvContent] = useState<string>('');
  const [loansAndDebtsFileName, setLoansAndDebtsFileName] = useState<string>('');
  const [esocialXmls, setEsocialXmls] = useState<string[]>([]);
  const [xmlFileNames, setXmlFileNames] = useState<string[]>([]);

  // Aba ativa na prévia
  const [activePreviewTab, setActivePreviewTab] = useState<'FOLHA' | 'VACATION' | 'LEAVES' | 'TIMEBANK' | 'LOANS'>('FOLHA');

  // Estados de execução
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<MigrationPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [executing, setExecuting] = useState(false);
  const [executeResult, setExecuteResult] = useState<MigrationExecuteResult | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);

  const [showGuideModal, setShowGuideModal] = useState(false);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      setLoadingTemplates(true);
      const data = await migrationService.getTemplates();
      setTemplates(data);
    } catch (err: any) {
      console.error('Erro ao carregar modelos:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleDownload = async (template: MigrationTemplateInfo) => {
    try {
      setDownloadingKey(template.key);
      await migrationService.downloadTemplate(template.key, template.filename);
    } catch (err: any) {
      alert(`Erro ao baixar modelo: ${err.message}`);
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleFileUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
    type: 'workers' | 'history' | 'vacations' | 'leaves' | 'timeBank' | 'loansAndDebts' | 'xml'
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (type === 'xml') {
      const readers: Promise<{ name: string; content: string }>[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        readers.push(
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (event) => {
              resolve({ name: file.name, content: (event.target?.result as string) || '' });
            };
            reader.readAsText(file, 'utf-8');
          })
        );
      }
      Promise.all(readers).then((results) => {
        setXmlFileNames(results.map((r) => r.name));
        setEsocialXmls(results.map((r) => r.content));
        setPreviewResult(null);
      });
      return;
    }

    const file = files[0];
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = (event.target?.result as string) || '';
      if (type === 'workers') {
        setWorkersFileName(file.name);
        setWorkersCsvContent(content);
      } else if (type === 'history') {
        setHistoryFileName(file.name);
        setHistoryCsvContent(content);
      } else if (type === 'vacations') {
        setVacationsFileName(file.name);
        setVacationsCsvContent(content);
      } else if (type === 'leaves') {
        setLeavesFileName(file.name);
        setLeavesCsvContent(content);
      } else if (type === 'timeBank') {
        setTimeBankFileName(file.name);
        setTimeBankCsvContent(content);
      } else if (type === 'loansAndDebts') {
        setLoansAndDebtsFileName(file.name);
        setLoansAndDebtsCsvContent(content);
      }
      setPreviewResult(null);
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleRunPreview = async () => {
    const hasAnyFile =
      workersCsvContent ||
      historyCsvContent ||
      vacationsCsvContent ||
      leavesCsvContent ||
      timeBankCsvContent ||
      loansAndDebtsCsvContent ||
      esocialXmls.length > 0;

    if (!hasAnyFile) {
      alert('Selecione ao menos um arquivo CSV ou XML para analisar.');
      return;
    }

    try {
      setPreviewLoading(true);
      setPreviewError(null);
      setExecuteResult(null);

      const result = await migrationService.previewMigration({
        rawWorkersCsv: workersCsvContent || undefined,
        rawHistoryCsv: historyCsvContent || undefined,
        rawVacationsCsv: vacationsCsvContent || undefined,
        rawLeavesCsv: leavesCsvContent || undefined,
        rawTimeBankCsv: timeBankCsvContent || undefined,
        rawLoansAndDebtsCsv: loansAndDebtsCsvContent || undefined,
        esocialXmls: esocialXmls.length > 0 ? esocialXmls : undefined,
      });

      setPreviewResult(result);
    } catch (err: any) {
      setPreviewError(err.message || 'Erro durante a análise preliminar.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleExecuteCommit = async () => {
    if (!previewResult || !previewResult.valid) {
      alert('Execute o Dry-Run e corrija eventuais erros antes de efetivar.');
      return;
    }

    if (
      !confirm(
        'Deseja realmente efetivar a carga histórica e os saldos vivos no banco de dados? Os períodos importados serão criados como FECHADOS (CLOSED), os saldos de férias, afastamentos, banco de horas e consignados serão ativados para cálculo de folha e 13º.'
      )
    ) {
      return;
    }

    try {
      setExecuting(true);
      setExecuteError(null);

      const res = await migrationService.executeMigration({
        rawWorkersCsv: workersCsvContent || undefined,
        rawHistoryCsv: historyCsvContent || undefined,
        rawVacationsCsv: vacationsCsvContent || undefined,
        rawLeavesCsv: leavesCsvContent || undefined,
        rawTimeBankCsv: timeBankCsvContent || undefined,
        rawLoansAndDebtsCsv: loansAndDebtsCsvContent || undefined,
        esocialXmls: esocialXmls.length > 0 ? esocialXmls : undefined,
      });

      setExecuteResult(res);
    } catch (err: any) {
      setExecuteError(err.message || 'Erro ao efetivar a carga no banco.');
    } finally {
      setExecuting(false);
    }
  };

  const formatBRL = (val: number) => {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);
  };

  return (
    <div className="space-y-8 p-6 max-w-7xl mx-auto">
      {/* Header Principal */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-gray-200 dark:border-gray-800 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
              Go-Live & Transição de Sistema
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
              13º Salário Pronto
            </span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
            Implantação & Carga de Histórico Externo (Jan/2026 até a Virada)
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Importe o histórico do sistema anterior para cálculo exato de médias de 13º Salário (Súmula 347 TST), faltas (Art. 130 CLT), férias e Regime de Caixa RFB.
          </p>
        </div>

        <button
          onClick={() => setShowGuideModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50 rounded-lg transition-colors border border-blue-200 dark:border-blue-800 shadow-sm"
        >
          <BookOpen className="w-4 h-4" />
          Guia de Preenchimento do RH
        </button>
      </div>

      {/* Seção 1: Central de Download dos Modelos Oficiais */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Download className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              1. Central de Download dos Modelos Oficiais de Importação
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Baixe as planilhas padrão prontas para o Excel (UTF-8 com BOM e separador ponto-e-vírgula). Preencha os dados e suba abaixo.
            </p>
          </div>
          <button
            onClick={loadTemplates}
            disabled={loadingTemplates}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 p-1 rounded"
            title="Atualizar lista"
          >
            <RefreshCw className={`w-4 h-4 ${loadingTemplates ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {loadingTemplates ? (
          <div className="py-8 text-center text-gray-500">Carregando modelos oficiais...</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((tpl) => (
              <div
                key={tpl.key}
                className="flex flex-col justify-between p-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30 hover:border-blue-400 dark:hover:border-blue-600 transition-all"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-medium ${
                        tpl.required
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                          : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {tpl.required ? 'Obrigatório p/ Folha' : 'Complementar'}
                    </span>
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                      {tpl.format} (BOM)
                    </span>
                  </div>
                  <h3 className="font-semibold text-gray-900 dark:text-white text-sm">
                    {tpl.title}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-3">
                    {tpl.description}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-gray-200 dark:border-gray-800">
                  <button
                    onClick={() => handleDownload(tpl)}
                    disabled={downloadingKey === tpl.key}
                    className="w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-semibold rounded text-blue-700 bg-blue-100/70 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60 transition-colors"
                  >
                    {downloadingKey === tpl.key ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Baixando...
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        Baixar Modelo ({tpl.filename})
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Seção 2: Área de Upload & Seleção de Arquivos */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-1">
          <UploadCloud className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          2. Seleção de Arquivos para Importação (CSV ou XML eSocial)
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Selecione a planilha preenchida de colaboradores, a ficha financeira histórica de 2026 ou os arquivos XML do eSocial extraídos do sistema descontinuado.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {/* Upload 01: Colaboradores */}
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-4 text-center hover:border-blue-500 transition-colors bg-gray-50/30 dark:bg-gray-800/20 flex flex-col justify-between">
            <div>
              <Users className="w-7 h-7 text-blue-600 mx-auto mb-1.5" />
              <h3 className="font-semibold text-xs text-gray-900 dark:text-white">
                01. Trabalhadores & Contratos
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5 mb-2">
                Dados cadastrais, salário base e admissão
              </p>
            </div>
            <div>
              <input
                type="file"
                accept=".csv"
                id="upload-workers"
                className="hidden"
                onChange={(e) => handleFileUpload(e, 'workers')}
              />
              <label
                htmlFor="upload-workers"
                className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-sm hover:bg-gray-50"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                {workersFileName ? 'Substituir' : 'Selecionar CSV'}
              </label>
              {workersFileName && (
                <div className="mt-1 text-[11px] font-semibold text-emerald-600 flex items-center justify-center gap-1 truncate">
                  <Check className="w-3 h-3 flex-shrink-0" /> {workersFileName}
                </div>
              )}
            </div>
          </div>

          {/* Upload 02: Histórico Folha */}
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-4 text-center hover:border-blue-500 transition-colors bg-gray-50/30 dark:bg-gray-800/20 flex flex-col justify-between">
            <div>
              <DollarSign className="w-7 h-7 text-indigo-600 mx-auto mb-1.5" />
              <h3 className="font-semibold text-xs text-gray-900 dark:text-white">
                02. Ficha Financeira 2026
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5 mb-2">
                Folhas mensais, horas extras e faltas
              </p>
            </div>
            <div>
              <input
                type="file"
                accept=".csv"
                id="upload-history"
                className="hidden"
                onChange={(e) => handleFileUpload(e, 'history')}
              />
              <label
                htmlFor="upload-history"
                className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-sm hover:bg-gray-50"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                {historyFileName ? 'Substituir' : 'Selecionar CSV'}
              </label>
              {historyFileName && (
                <div className="mt-1 text-[11px] font-semibold text-emerald-600 flex items-center justify-center gap-1 truncate">
                  <Check className="w-3 h-3 flex-shrink-0" /> {historyFileName}
                </div>
              )}
            </div>
          </div>

          {/* Upload 03: Férias & Aquisitivos */}
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-4 text-center hover:border-blue-500 transition-colors bg-gray-50/30 dark:bg-gray-800/20 flex flex-col justify-between">
            <div>
              <Calendar className="w-7 h-7 text-amber-600 mx-auto mb-1.5" />
              <h3 className="font-semibold text-xs text-gray-900 dark:text-white">
                03. Saldos de Férias
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5 mb-2">
                Aquisitivos, dias gozados e faltas CLT 130
              </p>
            </div>
            <div>
              <input
                type="file"
                accept=".csv"
                id="upload-vacations"
                className="hidden"
                onChange={(e) => handleFileUpload(e, 'vacations')}
              />
              <label
                htmlFor="upload-vacations"
                className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-sm hover:bg-gray-50"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                {vacationsFileName ? 'Substituir' : 'Selecionar CSV'}
              </label>
              {vacationsFileName && (
                <div className="mt-1 text-[11px] font-semibold text-emerald-600 flex items-center justify-center gap-1 truncate">
                  <Check className="w-3 h-3 flex-shrink-0" /> {vacationsFileName}
                </div>
              )}
            </div>
          </div>

          {/* Upload 04: Afastamentos */}
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-4 text-center hover:border-blue-500 transition-colors bg-gray-50/30 dark:bg-gray-800/20 flex flex-col justify-between">
            <div>
              <Clock className="w-7 h-7 text-rose-600 mx-auto mb-1.5" />
              <h3 className="font-semibold text-xs text-gray-900 dark:text-white">
                04. Afastamentos & Licenças
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5 mb-2">
                Doença 15d, maternidade, INSS e retorno
              </p>
            </div>
            <div>
              <input
                type="file"
                accept=".csv"
                id="upload-leaves"
                className="hidden"
                onChange={(e) => handleFileUpload(e, 'leaves')}
              />
              <label
                htmlFor="upload-leaves"
                className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-sm hover:bg-gray-50"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                {leavesFileName ? 'Substituir' : 'Selecionar CSV'}
              </label>
              {leavesFileName && (
                <div className="mt-1 text-[11px] font-semibold text-emerald-600 flex items-center justify-center gap-1 truncate">
                  <Check className="w-3 h-3 flex-shrink-0" /> {leavesFileName}
                </div>
              )}
            </div>
          </div>

          {/* Upload 05: Banco de Horas */}
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-4 text-center hover:border-blue-500 transition-colors bg-gray-50/30 dark:bg-gray-800/20 flex flex-col justify-between">
            <div>
              <Clock className="w-7 h-7 text-cyan-600 mx-auto mb-1.5" />
              <h3 className="font-semibold text-xs text-gray-900 dark:text-white">
                05. Banco de Horas Inicial
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5 mb-2">
                Saldo na virada (+/- minutos e corte)
              </p>
            </div>
            <div>
              <input
                type="file"
                accept=".csv"
                id="upload-timebank"
                className="hidden"
                onChange={(e) => handleFileUpload(e, 'timeBank')}
              />
              <label
                htmlFor="upload-timebank"
                className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-sm hover:bg-gray-50"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                {timeBankFileName ? 'Substituir' : 'Selecionar CSV'}
              </label>
              {timeBankFileName && (
                <div className="mt-1 text-[11px] font-semibold text-emerald-600 flex items-center justify-center gap-1 truncate">
                  <Check className="w-3 h-3 flex-shrink-0" /> {timeBankFileName}
                </div>
              )}
            </div>
          </div>

          {/* Upload 06: Consignados & Débitos 899 */}
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-4 text-center hover:border-blue-500 transition-colors bg-gray-50/30 dark:bg-gray-800/20 flex flex-col justify-between">
            <div>
              <DollarSign className="w-7 h-7 text-purple-600 mx-auto mb-1.5" />
              <h3 className="font-semibold text-xs text-gray-900 dark:text-white">
                06. Consignados & Débitos
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5 mb-2">
                Empréstimos ativos e saldo devedor 899
              </p>
            </div>
            <div>
              <input
                type="file"
                accept=".csv"
                id="upload-loans"
                className="hidden"
                onChange={(e) => handleFileUpload(e, 'loansAndDebts')}
              />
              <label
                htmlFor="upload-loans"
                className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-sm hover:bg-gray-50"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                {loansAndDebtsFileName ? 'Substituir' : 'Selecionar CSV'}
              </label>
              {loansAndDebtsFileName && (
                <div className="mt-1 text-[11px] font-semibold text-emerald-600 flex items-center justify-center gap-1 truncate">
                  <Check className="w-3 h-3 flex-shrink-0" /> {loansAndDebtsFileName}
                </div>
              )}
            </div>
          </div>

          {/* Upload XMLs eSocial */}
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-4 text-center hover:border-blue-500 transition-colors bg-gray-50/30 dark:bg-gray-800/20 flex flex-col justify-between sm:col-span-2 lg:col-span-1 xl:col-span-2">
            <div>
              <ShieldCheck className="w-7 h-7 text-emerald-600 mx-auto mb-1.5" />
              <h3 className="font-semibold text-xs text-gray-900 dark:text-white">
                XMLs Oficiais do eSocial
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5 mb-2">
                S-2200 (Admissão), S-1200 (Remuneração), S-1210 (Pgtos), S-2230 (Afastamentos)
              </p>
            </div>
            <div>
              <input
                type="file"
                accept=".xml"
                multiple
                id="upload-xml"
                className="hidden"
                onChange={(e) => handleFileUpload(e, 'xml')}
              />
              <label
                htmlFor="upload-xml"
                className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-sm hover:bg-gray-50"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                {xmlFileNames.length > 0 ? `${xmlFileNames.length} XMLs selecionados` : 'Selecionar XMLs'}
              </label>
              {xmlFileNames.length > 0 && (
                <div className="mt-1 text-[11px] font-semibold text-emerald-600 flex items-center justify-center gap-1">
                  <Check className="w-3 h-3 flex-shrink-0" /> {xmlFileNames.length} arquivos prontos
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Botão de Disparo do Dry-Run */}
        <div className="mt-6 flex items-center justify-between pt-4 border-t border-gray-200 dark:border-gray-800">
          <span className="text-xs text-gray-500">
            * O Dry-Run analisa sintaxe, integridade matemática e consistência contábil antes de gravar qualquer dado no banco.
          </span>
          <button
            onClick={handleRunPreview}
            disabled={
              previewLoading ||
              (!workersCsvContent &&
                !historyCsvContent &&
                !vacationsCsvContent &&
                !leavesCsvContent &&
                !timeBankCsvContent &&
                !loansAndDebtsCsvContent &&
                esocialXmls.length === 0)
            }
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition-all"
          >
            {previewLoading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Processando Dry-Run...
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" />
                Processar Prévia & Reconciliação (Dry-Run)
              </>
            )}
          </button>
        </div>

        {previewError && (
          <div className="mt-4 p-4 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-sm flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Erro no processamento da prévia:</strong>
              <p>{previewError}</p>
            </div>
          </div>
        )}
      </div>

      {/* Seção 3: Painel de Resultados do Dry-Run & Reconciliação */}
      {previewResult && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 shadow-sm space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Database className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                3. Relatório de Reconciliação Contábil & Prévia do Histórico
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Conferência matemática e sintática de todas as linhas de folha de Jan/2026 até a data de corte.
              </p>
            </div>

            {/* Banner de Reconciliação R$ 0,00 */}
            <div
              className={`px-4 py-2 rounded-lg border font-semibold text-sm flex items-center gap-2 ${
                previewResult.reconciliationDiff === 0
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                  : 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
              }`}
            >
              {previewResult.reconciliationDiff === 0 ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  Reconciliação Auditada: Diferença R$ 0,00 (Proventos - Descontos = Líquido)
                </>
              ) : (
                <>
                  <AlertTriangle className="w-5 h-5 text-rose-600" />
                  Divergência Contábil Detectada: {formatBRL(previewResult.reconciliationDiff)}
                </>
              )}
            </div>
          </div>

          {/* Cards de Métricas */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-800">
              <span className="text-[11px] text-gray-500 block">Colaboradores</span>
              <span className="text-lg font-bold text-gray-900 dark:text-white">
                {previewResult.totalWorkers}
              </span>
              <span className="text-[10px] text-gray-400 block mt-0.5">
                {previewResult.totalContracts} contrato(s)
              </span>
            </div>

            <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-800">
              <span className="text-[11px] text-gray-500 block">Folhas Detectadas</span>
              <span className="text-lg font-bold text-gray-900 dark:text-white">
                {previewResult.totalPeriods} meses
              </span>
              <span className="text-[10px] text-gray-400 block mt-0.5 truncate">
                {previewResult.periodsDetected.slice(0, 2).join(', ')}...
              </span>
            </div>

            <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-800">
              <span className="text-[11px] text-gray-500 block">Horas Extras</span>
              <span className="text-lg font-bold text-blue-600 dark:text-blue-400">
                {previewResult.totalOvertimeHours}h
              </span>
              <span className="text-[10px] text-gray-400 block mt-0.5">Súm. 347 TST</span>
            </div>

            <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-800">
              <span className="text-[11px] text-gray-500 block">Faltas Injust.</span>
              <span className="text-lg font-bold text-amber-600 dark:text-amber-400">
                {previewResult.totalAbsenceDays}d
              </span>
              <span className="text-[10px] text-gray-400 block mt-0.5">Art. 130 CLT</span>
            </div>

            <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-800">
              <span className="text-[11px] text-gray-500 block">Férias Vivas</span>
              <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                {previewResult.vacationsSummary?.totalVacationPeriods || 0}
              </span>
              <span className="text-[10px] text-gray-400 block mt-0.5">
                {previewResult.vacationsSummary?.totalDaysRemaining || 0}d saldo
              </span>
            </div>

            <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-800">
              <span className="text-[11px] text-gray-500 block">Afastamentos</span>
              <span className="text-lg font-bold text-rose-600 dark:text-rose-400">
                {previewResult.leavesSummary?.totalLeaves || 0}
              </span>
              <span className="text-[10px] text-gray-400 block mt-0.5">
                {previewResult.leavesSummary?.activeLeavesCount || 0} em curso
              </span>
            </div>

            <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-800">
              <span className="text-[11px] text-gray-500 block">Banco de Horas</span>
              <span className="text-lg font-bold text-cyan-600 dark:text-cyan-400">
                {previewResult.timeBankSummary?.totalAccounts || 0}
              </span>
              <span className="text-[10px] text-gray-400 block mt-0.5">
                {Math.round(((previewResult.timeBankSummary?.totalPositiveMinutes || 0) - (previewResult.timeBankSummary?.totalNegativeMinutes || 0)) / 60)}h saldo
              </span>
            </div>

            <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-800">
              <span className="text-[11px] text-gray-500 block">Consig. & Déb.</span>
              <span className="text-lg font-bold text-purple-600 dark:text-purple-400">
                {(previewResult.loansAndDebtsSummary?.totalConsignados || 0) + (previewResult.loansAndDebtsSummary?.totalDebitos899 || 0)}
              </span>
              <span className="text-[10px] text-gray-400 block mt-0.5">
                {formatBRL((previewResult.loansAndDebtsSummary?.totalConsignadoAmount || 0) + (previewResult.loansAndDebtsSummary?.totalDebito899Amount || 0))}
              </span>
            </div>
          </div>

          {/* Totais Financeiros */}
          <div className="p-4 rounded-lg bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
            <div>
              <span className="text-xs text-gray-500 uppercase font-medium">Total de Proventos Brutos</span>
              <p className="text-lg font-bold text-gray-900 dark:text-white">
                {formatBRL(previewResult.totalEarnings)}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-500 uppercase font-medium">Total de Descontos</span>
              <p className="text-lg font-bold text-gray-900 dark:text-white">
                {formatBRL(previewResult.totalDeductions)}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-500 uppercase font-medium">Total Líquido Efetivo</span>
              <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                {formatBRL(previewResult.totalNet)}
              </p>
            </div>
          </div>

          {/* Avisos e Recomendações */}
          {previewResult.warnings.length > 0 && (
            <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-xs space-y-1">
              <div className="font-semibold flex items-center gap-1 text-sm mb-1">
                <AlertTriangle className="w-4 h-4" />
                Alertas e Recomendações ({previewResult.warnings.length}):
              </div>
              <ul className="list-disc list-inside space-y-0.5">
                {previewResult.warnings.slice(0, 5).map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
              {previewResult.warnings.length > 5 && (
                <p className="text-gray-500 pt-1">
                  ... e mais {previewResult.warnings.length - 5} alertas similares.
                </p>
              )}
            </div>
          )}

          {/* Seletor de Abas de Conferência */}
          <div className="border-b border-gray-200 dark:border-gray-800 flex items-center gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setActivePreviewTab('FOLHA')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors border-b-2 flex items-center gap-1.5 ${
                activePreviewTab === 'FOLHA'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/20'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <DollarSign className="w-3.5 h-3.5" />
              Folhas & Competências ({previewResult.periodsSummary.length})
            </button>
            <button
              onClick={() => setActivePreviewTab('VACATION')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors border-b-2 flex items-center gap-1.5 ${
                activePreviewTab === 'VACATION'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/20'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              Férias & Aquisitivos ({previewResult.vacationsSummary?.totalVacationPeriods || 0})
            </button>
            <button
              onClick={() => setActivePreviewTab('LEAVES')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors border-b-2 flex items-center gap-1.5 ${
                activePreviewTab === 'LEAVES'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/20'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              Afastamentos ({previewResult.leavesSummary?.totalLeaves || 0})
            </button>
            <button
              onClick={() => setActivePreviewTab('TIMEBANK')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors border-b-2 flex items-center gap-1.5 ${
                activePreviewTab === 'TIMEBANK'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/20'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              Banco de Horas ({previewResult.timeBankSummary?.totalAccounts || 0})
            </button>
            <button
              onClick={() => setActivePreviewTab('LOANS')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors border-b-2 flex items-center gap-1.5 ${
                activePreviewTab === 'LOANS'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/20'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <DollarSign className="w-3.5 h-3.5" />
              Consignados & Débitos ({(previewResult.loansAndDebtsSummary?.totalConsignados || 0) + (previewResult.loansAndDebtsSummary?.totalDebitos899 || 0)})
            </button>
          </div>

          {/* Conteúdo da Aba Ativa */}
          {activePreviewTab === 'FOLHA' && (
            <div>
              <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
                <table className="w-full text-left text-xs text-gray-600 dark:text-gray-300">
                  <thead className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-800">
                    <tr>
                      <th className="p-2.5">Competência</th>
                      <th className="p-2.5">Tipo de Folha</th>
                      <th className="p-2.5">Holerites</th>
                      <th className="p-2.5 text-right">Proventos</th>
                      <th className="p-2.5 text-right">Descontos</th>
                      <th className="p-2.5 text-right">Líquido</th>
                      <th className="p-2.5 text-center">Status Contábil</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                    {previewResult.periodsSummary.map((ps, idx) => (
                      <tr key={idx} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/40">
                        <td className="p-2.5 font-medium text-gray-900 dark:text-white">
                          {ps.competence}
                        </td>
                        <td className="p-2.5">{ps.tipoFolha}</td>
                        <td className="p-2.5">{ps.slipsCount}</td>
                        <td className="p-2.5 text-right">{formatBRL(ps.totalEarnings)}</td>
                        <td className="p-2.5 text-right">{formatBRL(ps.totalDeductions)}</td>
                        <td className="p-2.5 text-right font-semibold text-emerald-600 dark:text-emerald-400">
                          {formatBRL(ps.totalNet)}
                        </td>
                        <td className="p-2.5 text-center">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                            R$ 0,00 OK
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activePreviewTab === 'VACATION' && (
            <div>
              {previewResult.vacationsSummary && previewResult.vacationsSummary.records.length > 0 ? (
                <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
                  <table className="w-full text-left text-xs text-gray-600 dark:text-gray-300">
                    <thead className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-800">
                      <tr>
                        <th className="p-2.5">CPF / Matrícula</th>
                        <th className="p-2.5">Colaborador</th>
                        <th className="p-2.5">Início Aquisitivo</th>
                        <th className="p-2.5">Fim Aquisitivo</th>
                        <th className="p-2.5 text-center">Saldo Restante</th>
                        <th className="p-2.5 text-center">Faltas Injust.</th>
                        <th className="p-2.5 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                      {previewResult.vacationsSummary.records.map((v, idx) => (
                        <tr key={idx} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/40">
                          <td className="p-2.5 font-mono text-[11px] text-gray-900 dark:text-white">
                            {v.cpf} ({v.matricula})
                          </td>
                          <td className="p-2.5 font-medium">{v.nome}</td>
                          <td className="p-2.5">{v.inicioAquisitivo}</td>
                          <td className="p-2.5">{v.fimAquisitivo}</td>
                          <td className="p-2.5 text-center font-bold text-emerald-600">
                            {v.diasSaldoRestante} dias
                          </td>
                          <td className="p-2.5 text-center">
                            {v.faltas > 0 ? (
                              <span className="text-amber-600 font-semibold">{v.faltas} faltas</span>
                            ) : (
                              '0'
                            )}
                          </td>
                          <td className="p-2.5 text-center">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                              {v.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-gray-500">
                  Nenhum arquivo de saldo de férias foi fornecido nesta análise.
                </div>
              )}
            </div>
          )}

          {activePreviewTab === 'LEAVES' && (
            <div>
              {previewResult.leavesSummary && previewResult.leavesSummary.records.length > 0 ? (
                <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
                  <table className="w-full text-left text-xs text-gray-600 dark:text-gray-300">
                    <thead className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-800">
                      <tr>
                        <th className="p-2.5">CPF / Matrícula</th>
                        <th className="p-2.5">Colaborador</th>
                        <th className="p-2.5">Tipo de Afastamento</th>
                        <th className="p-2.5">Início</th>
                        <th className="p-2.5">Término Previsto</th>
                        <th className="p-2.5">CID-10</th>
                        <th className="p-2.5">Estabilidade até</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                      {previewResult.leavesSummary.records.map((l, idx) => (
                        <tr key={idx} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/40">
                          <td className="p-2.5 font-mono text-[11px] text-gray-900 dark:text-white">
                            {l.cpf} ({l.matricula})
                          </td>
                          <td className="p-2.5 font-medium">{l.nome}</td>
                          <td className="p-2.5 font-semibold text-rose-600">{l.tipo}</td>
                          <td className="p-2.5">{l.dataInicio}</td>
                          <td className="p-2.5">{l.dataFim || 'Em aberto'}</td>
                          <td className="p-2.5 font-mono">{l.cid || '-'}</td>
                          <td className="p-2.5">{l.estabilidadeAte || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-gray-500">
                  Nenhum arquivo de afastamentos foi fornecido nesta análise.
                </div>
              )}
            </div>
          )}

          {activePreviewTab === 'TIMEBANK' && (
            <div>
              {previewResult.timeBankSummary && previewResult.timeBankSummary.records.length > 0 ? (
                <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
                  <table className="w-full text-left text-xs text-gray-600 dark:text-gray-300">
                    <thead className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-800">
                      <tr>
                        <th className="p-2.5">CPF / Matrícula</th>
                        <th className="p-2.5">Colaborador</th>
                        <th className="p-2.5 text-center">Saldo em Horas</th>
                        <th className="p-2.5 text-center">Saldo em Minutos</th>
                        <th className="p-2.5 text-center">Regime</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                      {previewResult.timeBankSummary.records.map((t, idx) => (
                        <tr key={idx} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/40">
                          <td className="p-2.5 font-mono text-[11px] text-gray-900 dark:text-white">
                            {t.cpf} ({t.matricula})
                          </td>
                          <td className="p-2.5 font-medium">{t.nome}</td>
                          <td className="p-2.5 text-center font-bold">
                            <span
                              className={
                                t.saldoMinutosLiquido >= 0 ? 'text-emerald-600' : 'text-rose-600'
                              }
                            >
                              {t.saldoHorasHhmm}
                            </span>
                          </td>
                          <td className="p-2.5 text-center font-mono text-gray-500">
                            {t.saldoMinutosLiquido} min
                          </td>
                          <td className="p-2.5 text-center">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300">
                              BANCO DE HORAS
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-gray-500">
                  Nenhum arquivo de saldo de banco de horas foi fornecido nesta análise.
                </div>
              )}
            </div>
          )}

          {activePreviewTab === 'LOANS' && (
            <div>
              {previewResult.loansAndDebtsSummary && previewResult.loansAndDebtsSummary.records.length > 0 ? (
                <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
                  <table className="w-full text-left text-xs text-gray-600 dark:text-gray-300">
                    <thead className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-800">
                      <tr>
                        <th className="p-2.5">CPF / Matrícula</th>
                        <th className="p-2.5">Colaborador</th>
                        <th className="p-2.5">Tipo de Registro</th>
                        <th className="p-2.5 text-right">Valor Restante</th>
                        <th className="p-2.5 text-center">Parcelas</th>
                        <th className="p-2.5 text-center">Rubrica de Desconto</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                      {previewResult.loansAndDebtsSummary.records.map((ld, idx) => (
                        <tr key={idx} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/40">
                          <td className="p-2.5 font-mono text-[11px] text-gray-900 dark:text-white">
                            {ld.cpf} ({ld.matricula})
                          </td>
                          <td className="p-2.5 font-medium">{ld.nome}</td>
                          <td className="p-2.5 font-semibold text-purple-600">{ld.tipo}</td>
                          <td className="p-2.5 text-right font-bold text-gray-900 dark:text-white">
                            {formatBRL(ld.valor)}
                          </td>
                          <td className="p-2.5 text-center font-mono">{ld.parcelasInfo || 'Única'}</td>
                          <td className="p-2.5 text-center">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
                              {ld.tipo === 'CONSIGNADO' ? '805 (Consignado 35%)' : '899 (Insuficiência Anterior)'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-gray-500">
                  Nenhum arquivo de consignados ou débitos anteriores foi fornecido nesta análise.
                </div>
              )}
            </div>
          )}

          {/* Botão de Efetivação / Commit */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
            <div className="text-xs text-gray-500">
              Ao confirmar, os períodos serão salvos no PostgreSQL 17 sob RLS como <strong>FECHADOS (CLOSED)</strong> para alimentar imediatamente o cálculo da 1ª parcela do 13º.
            </div>

            <button
              onClick={handleExecuteCommit}
              disabled={executing || !previewResult.valid}
              className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-bold rounded-lg text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 shadow-md transition-all"
            >
              {executing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Gravando no Banco de Dados...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  Efetivar Carga Histórica no Sistema
                </>
              )}
            </button>
          </div>

          {executeError && (
            <div className="p-4 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-sm">
              <strong>Erro ao efetivar migração:</strong> {executeError}
            </div>
          )}

          {executeResult && (
            <div className="p-5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 space-y-3">
              <div className="flex items-center gap-2 font-bold text-base">
                <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                Carga Histórica e Saldos Vivos Efetivados com Sucesso!
              </div>
              <p className="text-sm">{executeResult.message}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 pt-2 text-xs">
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Trabalhadores: <strong>{executeResult.workersImported}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Períodos Fechados: <strong>{executeResult.periodsImported}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Holerites Gravados: <strong>{executeResult.payslipsImported}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Períodos de Férias: <strong>{executeResult.vacationPeriodsImported || 0}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Afastamentos: <strong>{executeResult.leavesImported || 0}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Banco de Horas: <strong>{executeResult.timeBankAccountsImported || 0}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Consignados: <strong>{executeResult.loansImported || 0}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Débitos 899: <strong>{executeResult.balanceDebtsImported || 0}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Ledger IRRF Caixa: <strong>{executeResult.irrfLedgerEntries}</strong>
                </div>
                <div className="bg-white/60 dark:bg-black/20 p-2 rounded">
                  Provisões Contábeis: <strong>{executeResult.provisionsImported || 0}</strong>
                </div>
              </div>
              <div className="pt-2 flex items-center gap-4">
                <a
                  href="/folha/processamento"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                >
                  Ir para Cálculo de Folha (13º Salário) <ArrowRight className="w-3.5 h-3.5" />
                </a>
                <a
                  href="/funcionarios"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-200 hover:underline"
                >
                  Ver Colaboradores Importados
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal Guia Rápido de Preenchimento */}
      {showGuideModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 max-w-3xl w-full p-6 max-h-[85vh] overflow-y-auto space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b pb-3 border-gray-200 dark:border-gray-800">
              <h3 className="font-bold text-lg text-gray-900 dark:text-white flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-blue-600" />
                Guia Rápido de Preenchimento & De-Para de Rubricas
              </h3>
              <button
                onClick={() => setShowGuideModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm font-semibold"
              >
                ✕ Fechar
              </button>
            </div>

            <div className="text-xs text-gray-600 dark:text-gray-300 space-y-3 leading-relaxed">
              <p>
                Este guia orienta o RH para que a virada de sistema ocorra com <strong>divergência R$ 0,00</strong> e garanta que o <strong>13º Salário</strong> apure as médias de variáveis e avos com total conformidade trabalhista:
              </p>

              <div className="p-3 rounded bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900">
                <h4 className="font-bold text-blue-900 dark:text-blue-300 mb-1">
                  1. Médias de Horas Extras e Noturno (Súmula 347 TST)
                </h4>
                <p>
                  Na planilha <strong>02_historico_folha_2026_ficha_financeira.csv</strong>, ao informar rubricas de Horas Extras (102, 103) e Adicional Noturno (104), é <strong>OBRIGATÓRIO</strong> preencher a coluna <code>unidade_referencia = HORAS</code> e a <code>quantidade_referencia</code> (ex: 12.50). A lei veda fazer média por valor de R$, sob pena de passivo trabalhista em caso de reajuste salarial!
                </p>
              </div>

              <div className="p-3 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
                <h4 className="font-bold text-amber-900 dark:text-amber-300 mb-1">
                  2. Faltas Injustificadas (Art. 130 CLT)
                </h4>
                <p>
                  Para a rubrica <strong>801 (Faltas Injustificadas)</strong>, preencha <code>unidade_referencia = DIAS</code> e a quantidade de dias faltados no mês. O sistema desconta o avo do 13º no mês em que o colaborador tiver mais de 15 dias de falta sem justificativa (Lei 4.090/62).
                </p>
              </div>

              <div className="p-3 rounded bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                <h4 className="font-bold text-gray-900 dark:text-white mb-1">
                  3. Tabela de Rubricas Padrão CoupleRH
                </h4>
                <ul className="grid grid-cols-2 gap-1 font-mono text-[11px]">
                  <li>101: Salário Base Contratual</li>
                  <li>102: Horas Extras 50%</li>
                  <li>103: Horas Extras 100%</li>
                  <li>104: Adicional Noturno 20%</li>
                  <li>105: Adicional Periculosidade (30%)</li>
                  <li>401: DSR sobre Horas Extras</li>
                  <li>601: 13º Salário (1ª Parcela)</li>
                  <li>602: 13º Salário (2ª Parcela)</li>
                  <li>801: Faltas Injustificadas (dias)</li>
                  <li>803: Atrasos / Saídas Antecipadas</li>
                  <li>901: Contribuição INSS</li>
                  <li>902: Imposto de Renda IRRF</li>
                  <li>905: Desconto Vale Transporte</li>
                  <li>907: Desconto Plano de Saúde</li>
                </ul>
              </div>
            </div>

            <div className="pt-2 text-right border-t border-gray-200 dark:border-gray-800">
              <button
                onClick={() => setShowGuideModal(false)}
                className="px-4 py-1.5 text-xs font-semibold rounded bg-gray-800 text-white hover:bg-gray-700"
              >
                Entendi, Fechar Guia
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
