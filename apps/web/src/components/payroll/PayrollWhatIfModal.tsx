import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Play,
  SlidersHorizontal,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '../../lib/apiClient';

interface PayrollWhatIfModalProps {
  isOpen: boolean;
  onClose: () => void;
  periodId: string;
  periodLabel: string;
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface WhatIfFinancialBlock {
  total_earnings: number;
  total_deductions: number;
  total_net: number;
  total_inss_employee: number;
  total_irrf_employee: number;
  total_fgts_month: number;
  employer_taxes: {
    inss_patronal: number;
    rat_adjusted: number;
    terceiros: number;
    fgts_patronal: number;
    total_taxes: number;
  };
  total_company_cost: number;
}

interface WhatIfComparisonSummary {
  mode: 'SIMULATION';
  total_contracts: number;
  affected_contracts: number;
  chunks_processed: number;
  duration_ms: number;
  baseline: WhatIfFinancialBlock;
  simulated: WhatIfFinancialBlock;
  delta: WhatIfFinancialBlock;
  pct_company_cost_change: number;
  by_department: Array<{
    department_id: string | null;
    total_contracts: number;
    affected_contracts: number;
    baseline_earnings: number;
    simulated_earnings: number;
    delta_earnings: number;
    baseline_net: number;
    simulated_net: number;
    delta_net: number;
  }>;
  top_impacts: Array<{
    contract_id: string;
    worker_name?: string;
    department_id?: string | null;
    baseline_earnings: number;
    simulated_earnings: number;
    delta_earnings: number;
    baseline_net: number;
    simulated_net: number;
    delta_net: number;
  }>;
}

export const PayrollWhatIfModal: React.FC<PayrollWhatIfModalProps> = ({
  isOpen,
  onClose,
  periodId,
  periodLabel,
}) => {
  const [label, setLabel] = useState('Reajuste / Cenário Simulado');
  const [salaryIncreasePct, setSalaryIncreasePct] = useState<string>('6.5');
  const [salaryIncreaseFixed, setSalaryIncreaseFixed] = useState<string>('0');
  const [bonusAmount, setBonusAmount] = useState<string>('0');
  const [overtimeDelta, setOvertimeDelta] = useState<string>('0');
  const [departmentId, setDepartmentId] = useState<string>('');
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);

  const [running, setRunning] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [summary, setSummary] = useState<WhatIfComparisonSummary | null>(null);

  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;

    apiClient
      .get<{ success: boolean; data: DepartmentOption[] }>('/api/v1/org/departments')
      .then((res) => {
        if (active && Array.isArray(res?.data)) {
          setDepartments(res.data);
        }
      })
      .catch(() => {
        // Falha silenciosa na lista opcional de departamentos
      });

    return () => {
      active = false;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val || 0);

  const formatSignedCurrency = (val: number) => {
    const formatted = formatCurrency(Math.abs(val || 0));
    if (val > 0) return `+${formatted}`;
    if (val < 0) return `-${formatted}`;
    return formatted;
  };

  const getDepartmentName = (id: string | null) => {
    if (!id) return 'Sem Departamento';
    return departments.find((d) => d.id === id)?.name || id.slice(0, 8);
  };

  const pollJob = async (jobId: string) => {
    try {
      const res = await apiClient.get<{ success: boolean; job: any }>(`/api/v1/payroll/jobs/${jobId}`);
      const job = res.job;
      if (!job) {
        throw new Error('Job de simulação não encontrado.');
      }

      setProgressPct(Number(job.progress_pct || 0));
      setProgressLabel(
        `Simulando lote: ${job.processed_contracts || 0} / ${job.total_contracts || 0} contratos`
      );

      if (job.status === 'COMPLETED') {
        setSummary(job.summary_json as WhatIfComparisonSummary);
        setRunning(false);
        toast.success('Simulação What-If concluída sem alterar os holerites oficiais.');
        return;
      }

      if (job.status === 'FAILED' || job.status === 'CANCELLED') {
        const err =
          Array.isArray(job.errors_json) && job.errors_json[0]?.error
            ? job.errors_json[0].error
            : 'Falha ao executar simulação.';
        setErrorMsg(err);
        setRunning(false);
        return;
      }

      pollTimerRef.current = window.setTimeout(() => {
        pollJob(jobId);
      }, 350);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao consultar andamento da simulação.');
      setRunning(false);
    }
  };

  const handleRunSimulation = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSummary(null);
    setRunning(true);
    setProgressPct(5);
    setProgressLabel('Iniciando lote de simulação...');

    try {
      const res = await apiClient.post<{ success: boolean; job: any; error?: string }>(
        '/api/v1/payroll/simulate',
        {
          period_id: periodId,
          scenario_params: {
            label: label.trim() || 'Cenário What-If',
            salary_increase_pct: Number(salaryIncreasePct || 0),
            salary_increase_fixed: Number(salaryIncreaseFixed || 0),
            bonus_amount: Number(bonusAmount || 0),
            overtime_hours_delta: Number(overtimeDelta || 0),
            department_id: departmentId || null,
          },
        }
      );

      if (!res?.success || !res?.job?.id) {
        throw new Error(res?.error || 'Não foi possível iniciar a simulação.');
      }

      if (res.job.status === 'COMPLETED') {
        setSummary(res.job.summary_json as WhatIfComparisonSummary);
        setRunning(false);
      } else {
        await pollJob(res.job.id);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao disparar simulação What-If.');
      setRunning(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/60 p-4">
      <div className="bg-white rounded-lg shadow-md w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-slate-900 text-white">
              <SlidersHorizontal size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Simulador What-If em Lote — {periodLabel}
              </h2>
              <p className="text-xs text-slate-600">
                Projeção financeira e encargos patronais sem alterar holerites oficiais.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
            aria-label="Fechar simulador"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700 flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
            <span>
              Execução 100% isolada em memória e chunks de 50 contratos: nenhum dado de{' '}
              <code className="font-mono">payslips</code> ou competência é gravado ou alterado.
            </span>
          </div>

          <form onSubmit={handleRunSimulation} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="sm:col-span-2 lg:col-span-1">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Nome do Cenário
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                placeholder="Ex: Dissídio 6,5%"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Departamento (Opcional)
              </label>
              <select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                <option value="">Todos os departamentos</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Reajuste Salarial (%)
              </label>
              <input
                type="number"
                step="0.01"
                value={salaryIncreasePct}
                onChange={(e) => setSalaryIncreasePct(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Acréscimo Salarial Fixo (R$)
              </label>
              <input
                type="number"
                step="0.01"
                value={salaryIncreaseFixed}
                onChange={(e) => setSalaryIncreaseFixed(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Bônus / Prêmio Único (R$)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={bonusAmount}
                onChange={(e) => setBonusAmount(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Delta Horas Extras 50% (h)
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={overtimeDelta}
                onChange={(e) => setOvertimeDelta(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div className="sm:col-span-2 lg:col-span-3 flex justify-end pt-1">
              <button
                type="submit"
                disabled={running}
                className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                {running ? 'Processando Simulação...' : 'Executar Simulação What-If'}
              </button>
            </div>
          </form>

          {/* Loading Progress */}
          {running && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
              <div className="flex justify-between text-xs font-semibold text-slate-700">
                <span>{progressLabel}</span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-2.5 w-full rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full bg-slate-900 transition-all duration-150"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Error State */}
          {errorMsg && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-4 flex items-start gap-3 text-sm text-rose-800">
              <AlertCircle size={18} className="text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Erro na simulação</p>
                <p className="text-xs mt-0.5">{errorMsg}</p>
              </div>
            </div>
          )}

          {/* Empty State */}
          {!running && !errorMsg && !summary && (
            <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-500 text-sm">
              Configure os parâmetros acima e clique em <strong>Executar Simulação What-If</strong> para visualizar o comparativo financeiro.
            </div>
          )}

          {/* Results */}
          {summary && (
            <div className="space-y-6">
              {/* KPI Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Custo Total Empresa</p>
                  <p className="text-lg font-bold text-slate-900 mt-1">
                    {formatCurrency(summary.simulated.total_company_cost)}
                  </p>
                  <p className="text-xs text-slate-600 mt-1">
                    Base: {formatCurrency(summary.baseline.total_company_cost)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Impacto Financeiro</p>
                  <p
                    className={`text-lg font-bold mt-1 ${
                      summary.delta.total_company_cost > 0
                        ? 'text-rose-700'
                        : summary.delta.total_company_cost < 0
                          ? 'text-emerald-700'
                          : 'text-slate-900'
                    }`}
                  >
                    {formatSignedCurrency(summary.delta.total_company_cost)}
                  </p>
                  <p className="text-xs text-slate-600 mt-1 flex items-center gap-1">
                    <TrendingUp size={13} />
                    Variação: {summary.pct_company_cost_change > 0 ? '+' : ''}
                    {summary.pct_company_cost_change}%
                  </p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Encargos Patronais</p>
                  <p className="text-lg font-bold text-slate-900 mt-1">
                    {formatCurrency(summary.simulated.employer_taxes.total_taxes)}
                  </p>
                  <p className="text-xs text-slate-600 mt-1">
                    Delta: {formatSignedCurrency(summary.delta.employer_taxes.total_taxes)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Abrangência</p>
                  <p className="text-lg font-bold text-slate-900 mt-1 flex items-center gap-1.5">
                    <Users size={18} className="text-slate-600" />
                    {summary.affected_contracts} / {summary.total_contracts}
                  </p>
                  <p className="text-xs text-slate-600 mt-1">
                    {summary.chunks_processed} lotes em {summary.duration_ms}ms
                  </p>
                </div>
              </div>

              {/* Comparativo por Departamento */}
              <div className="rounded-lg border border-slate-200 bg-white overflow-hidden shadow-sm">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-bold uppercase tracking-wider text-slate-700">
                  Comparativo por Departamento
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600 border-b border-slate-200">
                      <tr>
                        <th className="px-4 py-2.5 font-semibold">Departamento</th>
                        <th className="px-4 py-2.5 font-semibold text-right">Afetados</th>
                        <th className="px-4 py-2.5 font-semibold text-right">Bruto Base</th>
                        <th className="px-4 py-2.5 font-semibold text-right">Bruto Simulado</th>
                        <th className="px-4 py-2.5 font-semibold text-right">Delta Bruto</th>
                        <th className="px-4 py-2.5 font-semibold text-right">Delta Líquido</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {summary.by_department.map((dept, idx) => (
                        <tr key={dept.department_id || idx} className="hover:bg-slate-50">
                          <td className="px-4 py-2.5 font-medium text-slate-900">
                            {getDepartmentName(dept.department_id)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-slate-700">
                            {dept.affected_contracts} / {dept.total_contracts}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                            {formatCurrency(dept.baseline_earnings)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-900">
                            {formatCurrency(dept.simulated_earnings)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono font-semibold text-rose-700">
                            {formatSignedCurrency(dept.delta_earnings)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-800">
                            {formatSignedCurrency(dept.delta_net)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Maiores Impactos Individuais */}
              {summary.top_impacts.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-white overflow-hidden shadow-sm">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-bold uppercase tracking-wider text-slate-700">
                    Maiores Impactos Individuais (Top {summary.top_impacts.length})
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-600 border-b border-slate-200">
                        <tr>
                          <th className="px-4 py-2.5 font-semibold">Colaborador</th>
                          <th className="px-4 py-2.5 font-semibold text-right">Bruto Base</th>
                          <th className="px-4 py-2.5 font-semibold text-right">Bruto Simulado</th>
                          <th className="px-4 py-2.5 font-semibold text-right">Delta Bruto</th>
                          <th className="px-4 py-2.5 font-semibold text-right">Líquido Simulado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {summary.top_impacts.map((imp) => (
                          <tr key={imp.contract_id} className="hover:bg-slate-50">
                            <td className="px-4 py-2.5 font-medium text-slate-900">
                              {imp.worker_name || imp.contract_id}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                              {formatCurrency(imp.baseline_earnings)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-900">
                              {formatCurrency(imp.simulated_earnings)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono font-semibold text-rose-700">
                              {formatSignedCurrency(imp.delta_earnings)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-800">
                              {formatCurrency(imp.simulated_net)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
