import { useState, useEffect } from "react";
import { ArrowLeft, Save, Building2 } from "lucide-react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/apiClient";
import { useAuth } from "../../contexts/AuthContext";

export default function CompanyForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(!!id);
  const [errorMsg, setErrorMsg] = useState("");
  const [formData, setFormData] = useState({
    corporate_name: "",
    trade_name: "",
    cnpj: "",
    tax_regime: "SIMPLES_NACIONAL",
    address: "",
    primary_cnae: "",
    legal_nature: "",
    status: "ACTIVE",
    salary_payment_rule: "FIFTH_BUSINESS_DAY" as "FIFTH_BUSINESS_DAY" | "LAST_DAY_OF_MONTH",
    withhold_irrf_on_advance: false,
    is_cprb_exempted: false,
    cprb_gross_revenue_total: "",
    cprb_gross_revenue_exempt: "",
    cprb_reoneration_year: "",
    fiscal_config_json: "",
    labor_config_json: "",
  });



  useEffect(() => {
    if (id) {
      fetchCompany();
    }
  }, [id]);

  const fetchCompany = async () => {
    try {
      const { data, error } = await supabase
        .from("companies")
        .select("*")
        .eq("id", id)
        .single();
        
      if (error) throw error;
      if (data) {
        setFormData({
          corporate_name: data.corporate_name || "",
          trade_name: data.trade_name || "",
          cnpj: data.cnpj || "",
          tax_regime: data.tax_regime || "SIMPLES_NACIONAL",
          address: data.address || "",
          primary_cnae: data.primary_cnae || "",
          legal_nature: data.legal_nature || "",
          status: data.status || "ACTIVE",
          salary_payment_rule:
            data.labor_config?.salary_payment_rule === "LAST_DAY_OF_MONTH"
              ? "LAST_DAY_OF_MONTH"
              : "FIFTH_BUSINESS_DAY",
          withhold_irrf_on_advance: Boolean(data.labor_config?.withhold_irrf_on_advance),
          is_cprb_exempted: Boolean(data.labor_config?.is_cprb_exempted),
          cprb_gross_revenue_total:
            data.cprb_gross_revenue_total !== null && data.cprb_gross_revenue_total !== undefined
              ? String(data.cprb_gross_revenue_total)
              : "",
          cprb_gross_revenue_exempt:
            data.cprb_gross_revenue_exempt !== null && data.cprb_gross_revenue_exempt !== undefined
              ? String(data.cprb_gross_revenue_exempt)
              : "",
          cprb_reoneration_year:
            data.cprb_reoneration_year !== null && data.cprb_reoneration_year !== undefined
              ? String(data.cprb_reoneration_year)
              : "",
          fiscal_config_json: data.fiscal_config ? JSON.stringify(data.fiscal_config, null, 2) : "",
          labor_config_json: data.labor_config ? JSON.stringify(data.labor_config, null, 2) : "",
        });
      }
    } catch (err: any) {
      console.error("Erro ao carregar empresa:", err);
      setErrorMsg("Falha ao carregar dados da empresa.");
    } finally {
      setFetching(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg("");

    try {
      if (!user) throw new Error("Usuário não autenticado.");

      // Buscar o tenant_id do usuário logado
      const { data: tenantData, error: tenantError } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", user.id)
        .limit(1)
        .single();

      if (tenantError || !tenantData) {
        throw new Error(
          "Não foi possível identificar o tenant do usuário (organização).",
        );
      }

      const parsedLabor = formData.labor_config_json ? JSON.parse(formData.labor_config_json) : {};
      const payload = {
        tenant_id: tenantData.tenant_id,
        corporate_name: formData.corporate_name,
        trade_name: formData.trade_name,
        cnpj: formData.cnpj.replace(/\D/g, ""),
        tax_regime: formData.tax_regime,
        address: formData.address,
        primary_cnae: formData.primary_cnae,
        legal_nature: formData.legal_nature,
        status: formData.status,
        cprb_gross_revenue_total: formData.cprb_gross_revenue_total
          ? Number(formData.cprb_gross_revenue_total)
          : 0,
        cprb_gross_revenue_exempt: formData.cprb_gross_revenue_exempt
          ? Number(formData.cprb_gross_revenue_exempt)
          : 0,
        cprb_reoneration_year: formData.cprb_reoneration_year
          ? Number(formData.cprb_reoneration_year)
          : null,
        fiscal_config: formData.fiscal_config_json ? JSON.parse(formData.fiscal_config_json) : {},
        labor_config: {
          ...parsedLabor,
          salary_payment_rule: formData.salary_payment_rule,
          withhold_irrf_on_advance: formData.withhold_irrf_on_advance,
          is_cprb_exempted: formData.is_cprb_exempted,
        },
      };

      if (id) {
        const { error } = await supabase.from("companies").update(payload).eq("id", id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("companies").insert([payload]);
        if (error) throw error;
      }

      navigate("/empresas");
    } catch (error: any) {
      console.error("Erro ao salvar empresa:", error);
      setErrorMsg(
        error.message ||
          `Erro de permissão no Supabase (RLS 403) ou outro erro: ${JSON.stringify(error)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="animate-fade-up max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate("/empresas")} className="btn-ghost p-2">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 font-display">
            {id ? "Editar Empresa" : "Nova Empresa"}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {id ? "Altere as informações da matriz." : "Cadastre a matriz e depois adicione as filiais/unidades na configuração da empresa."}
          </p>
        </div>
      </div>

      <div className="panel p-0 min-h-[400px]">
        <div className="p-6 lg:p-8">
          {fetching ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-500">
              <div className="w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mb-4"></div>
              Carregando dados...
            </div>
          ) : (
            <>
              {errorMsg && (
                <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-medium">
                  {errorMsg}
                </div>
              )}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="flex items-center gap-3 border-b border-slate-100 pb-4 mb-6">
              <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center text-primary-600 border border-primary-100">
                <Building2 size={20} />
              </div>
              <h2 className="text-lg font-bold text-slate-800">
                Dados da Empresa Matriz
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="col-span-1 md:col-span-2">
                <label className="input-label">Razão Social *</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Minha Empresa LTDA"
                  className="input"
                  value={formData.corporate_name}
                  onChange={(e) =>
                    setFormData({ ...formData, corporate_name: e.target.value })
                  }
                />
              </div>

              <div>
                <label className="input-label">Nome Fantasia</label>
                <input
                  type="text"
                  placeholder="Ex: Minha Empresa"
                  className="input"
                  value={formData.trade_name}
                  onChange={(e) =>
                    setFormData({ ...formData, trade_name: e.target.value })
                  }
                />
              </div>

              <div>
                <label className="input-label">CNPJ *</label>
                <input
                  type="text"
                  required
                  placeholder="00.000.000/0001-00"
                  className="input font-mono"
                  value={formData.cnpj}
                  onChange={(e) =>
                    setFormData({ ...formData, cnpj: e.target.value })
                  }
                />
              </div>

              <div>
                <label className="input-label">Regime Tributário *</label>
                <select
                  required
                  className="input"
                  value={formData.tax_regime}
                  onChange={(e) =>
                    setFormData({ ...formData, tax_regime: e.target.value })
                  }
                >
                  <option value="SIMPLES_NACIONAL">Simples Nacional</option>
                  <option value="LUCRO_PRESUMIDO">Lucro Presumido</option>
                  <option value="LUCRO_REAL">Lucro Real</option>
                  <option value="MEI">
                    Microempreendedor Individual (MEI)
                  </option>
                </select>
              </div>

              <div className="col-span-1 md:col-span-2">
                <label className="input-label">Endereço Completo</label>
                <input
                  type="text"
                  placeholder="Rua, Número, Bairro, Cidade - UF, CEP"
                  className="input"
                  value={formData.address}
                  onChange={(e) =>
                    setFormData({ ...formData, address: e.target.value })
                  }
                />
              </div>

              <div>
                <label className="input-label">CNAE Principal</label>
                <input
                  type="text"
                  placeholder="Ex: 6204-0/00"
                  className="input"
                  value={formData.primary_cnae}
                  onChange={(e) =>
                    setFormData({ ...formData, primary_cnae: e.target.value })
                  }
                />
              </div>

              <div>
                <label className="input-label">Natureza Jurídica</label>
                <input
                  type="text"
                  placeholder="Ex: 206-2 - Sociedade Empresária Limitada"
                  className="input"
                  value={formData.legal_nature}
                  onChange={(e) =>
                    setFormData({ ...formData, legal_nature: e.target.value })
                  }
                />
              </div>

              <div>
                <label className="input-label">Status *</label>
                <select
                  required
                  className="input"
                  value={formData.status}
                  onChange={(e) =>
                    setFormData({ ...formData, status: e.target.value })
                  }
                >
                  <option value="ACTIVE">Ativo</option>
                  <option value="INACTIVE">Inativo</option>
                  <option value="SUSPENDED">Suspenso</option>
                </select>
              </div>
            </div>

            <div className="flex items-center gap-3 border-b border-slate-100 pb-4 mb-6 mt-8">
              <h2 className="text-lg font-bold text-slate-800">
                Política de Pagamento & IRRF (Regime de Caixa)
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div>
                <label className="input-label">Regra Padrão de Pagamento da Folha Mensal</label>
                <select
                  className="input"
                  value={formData.salary_payment_rule}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      salary_payment_rule: e.target.value as "FIFTH_BUSINESS_DAY" | "LAST_DAY_OF_MONTH",
                    })
                  }
                >
                  <option value="FIFTH_BUSINESS_DAY">5º Dia Útil do Mês Seguinte (CLT art. 459)</option>
                  <option value="LAST_DAY_OF_MONTH">Último Dia do Próprio Mês</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  Define automaticamente a data de pagamento ao abrir novas competências (Lei 7.713/88).
                </p>
              </div>

              <div className="flex items-start pt-6">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900"
                    checked={formData.withhold_irrf_on_advance}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        withhold_irrf_on_advance: e.target.checked,
                      })
                    }
                  />
                  <div>
                    <span className="text-sm font-semibold text-slate-800 block">
                      Reter IRRF no Adiantamento Salarial (Regime de Caixa)
                    </span>
                    <span className="text-xs text-slate-500">
                      Soma salário pago no 5º dia útil + adiantamento no mesmo mês de caixa e retém a diferença.
                    </span>
                  </div>
                </label>
              </div>
            </div>

            <div className="flex items-center gap-3 border-b border-slate-100 pb-4 mb-6 mt-8">
              <h2 className="text-lg font-bold text-slate-800">
                Desoneração da Folha / CPRB (Lei 14.973/2024)
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div className="md:col-span-2">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900"
                    checked={formData.is_cprb_exempted}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        is_cprb_exempted: e.target.checked,
                      })
                    }
                  />
                  <div>
                    <span className="text-sm font-semibold text-slate-800 block">
                      Empresa Enquadrada na CPRB (Desoneração da Folha)
                    </span>
                    <span className="text-xs text-slate-500">
                      Habilita a transição gradual da CPP sobre empregados CLT conforme cronograma da Lei 14.973/2024 (pró-labore permanece em 20%).
                    </span>
                  </div>
                </label>
              </div>

              {formData.is_cprb_exempted && (
                <>
                  <div>
                    <label className="input-label">Receita Bruta Total (R$)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Ex: 1000000.00"
                      className="input font-mono"
                      value={formData.cprb_gross_revenue_total}
                      onChange={(e) =>
                        setFormData({ ...formData, cprb_gross_revenue_total: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className="input-label">Receita Bruta Desonerada (R$)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Ex: 600000.00"
                      className="input font-mono"
                      value={formData.cprb_gross_revenue_exempt}
                      onChange={(e) =>
                        setFormData({ ...formData, cprb_gross_revenue_exempt: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className="input-label">Ano-Base de Reoneração (Opcional)</label>
                    <input
                      type="number"
                      min="2024"
                      max="2035"
                      placeholder="Automático pelo ano da competência"
                      className="input font-mono"
                      value={formData.cprb_reoneration_year}
                      onChange={(e) =>
                        setFormData({ ...formData, cprb_reoneration_year: e.target.value })
                      }
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center gap-3 border-b border-slate-100 pb-4 mb-6 mt-8">
              <h2 className="text-lg font-bold text-slate-800">
                Configurações Avançadas (JSON)
              </h2>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="input-label">Configurações Fiscais</label>
                <textarea
                  className="input font-mono text-sm h-24"
                  placeholder='{"aliquota_rat": 1.0, "fap": 1.0}'
                  value={formData.fiscal_config_json}
                  onChange={(e) =>
                    setFormData({ ...formData, fiscal_config_json: e.target.value })
                  }
                ></textarea>
                <p className="text-xs text-slate-500 mt-1">Formato JSON. Opcional.</p>
              </div>

              <div>
                <label className="input-label">Configurações Trabalhistas</label>
                <textarea
                  className="input font-mono text-sm h-24"
                  placeholder='{"desconta_dsr": true}'
                  value={formData.labor_config_json}
                  onChange={(e) =>
                    setFormData({ ...formData, labor_config_json: e.target.value })
                  }
                ></textarea>
                <p className="text-xs text-slate-500 mt-1">Formato JSON. Opcional.</p>
              </div>
            </div>

            <div className="pt-6 border-t border-slate-100 flex justify-end gap-3 mt-8">
              <button
                type="button"
                onClick={() => navigate("/empresas")}
                className="btn-secondary"
              >
                Cancelar
              </button>
              <button type="submit" disabled={loading} className="btn-primary">
                <Save size={18} />
                {loading ? "Salvando..." : "Salvar Empresa"}
              </button>
            </div>
          </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
