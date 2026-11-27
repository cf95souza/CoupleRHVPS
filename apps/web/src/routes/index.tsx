import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import DashboardLayout from '../layouts/DashboardLayout';
import ProtectedRoute from '../components/ProtectedRoute';
import RequirePermission from '../components/auth/RequirePermission';
import AccessDenied403 from '../pages/AccessDenied403';
import { AuthProvider } from '../contexts/AuthContext';
import { CompanyProvider } from '../contexts/CompanyContext';
import Login from '../pages/Login';
import UpdatePassword from '../pages/UpdatePassword';
import Templates from '../pages/Documents/Templates';
import SignaturesVault from '../pages/Documents/SignaturesVault';
import PersonalDocsInbox from '../pages/Documents/PersonalDocsInbox';
import EmployeePortal from '../pages/Portals/EmployeePortal';
import EmployeePortalLogin from '../pages/Portals/Login';
import PublicDocumentVerification from '../pages/Public/PublicDocumentVerification';
import PublicPunchVerification from '../pages/Public/PublicPunchVerification';
import ManagerApprovals from '../pages/Approvals/ManagerApprovals';
import VacationsList from '../pages/Vacations/List';
import VacationWizard from '../pages/Vacations/Wizard';
import LeavesList from '../pages/Leaves/List';
import LeaveWizard from '../pages/Leaves/Wizard';
import BenefitsList from '../pages/Benefits/List';
import BenefitForm from '../pages/Benefits/Form';
import Timesheet from '../pages/TimeTracking/Timesheet';
import TimeManagement from '../pages/TimeTracking/TimeManagement';
import PayrollRubrics from '../pages/Payroll/Rubrics';
import PayrollEvents from '../pages/Payroll/Events';
import PayrollCalculations from '../pages/Payroll/Calculations';
import Payslips from '../pages/Payroll/Payslips';
import PayrollReports from '../pages/Payroll/Reports';
import AccountingHub from '../pages/Accounting/AccountingHub';
import TerminationsList from '../pages/Offboarding/List';
import OffboardingWizard from '../pages/Offboarding/Wizard';
import Movements from '../pages/Movements';
import ESocialDashboard from '../pages/eSocial/Dashboard';
import SstDashboard from '../pages/SST/Dashboard';
import Dashboard from '../pages/Dashboard';
import SettingsDashboard from '../pages/Settings/Dashboard';
import LegalTablesList from '../pages/Settings/LegalTables/List';
import LegalTablesForm from '../pages/Settings/LegalTables/Form';
import LogViewer from '../pages/Audit/LogViewer';
import AdmissionWizard from '../pages/PublicAdmission/AdmissionWizard';
import AdmissionManagement from '../pages/Admissions/AdmissionManagement';
import Help from '../pages/Help';
import DataImport from '../pages/Migration/DataImport';

import CompaniesList from '../pages/Companies/List';
import CompanyForm from '../pages/Companies/Form';
import DepartmentsList from '../pages/Organization/Departments/List';
import DepartmentForm from '../pages/Organization/Departments/Form';
import SectorsList from '../pages/Organization/Sectors/List';
import SectorForm from '../pages/Organization/Sectors/Form';
import PositionsList from '../pages/Organization/Positions/List';
import PositionForm from '../pages/Organization/Positions/Form';
import CostCentersList from '../pages/Organization/CostCenters/List';
import CostCenterForm from '../pages/Organization/CostCenters/Form';
import WorkplacesList from '../pages/Organization/Workplaces/List';
import WorkplaceForm from '../pages/Organization/Workplaces/Form';
import WorkSchedulesList from '../pages/Timekeeping/WorkSchedules/List';
import WorkScheduleForm from '../pages/Timekeeping/WorkSchedules/Form';
import HolidaysList from '../pages/Timekeeping/Holidays/List';
import HolidayForm from '../pages/Timekeeping/Holidays/Form';
import ContractTypesList from '../pages/Organization/ContractTypes/List';
import ContractTypeForm from '../pages/Organization/ContractTypes/Form';
import UnionsList from '../pages/Organization/Unions/List';
import EmployeesList from '../pages/Employees/List';
import EmployeeProfile from '../pages/Employees/Profile';

export function AppRoutes() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/update-password" element={<UpdatePassword />} />
          <Route path="/portal/login" element={<EmployeePortalLogin />} />
          <Route path="/portal/dashboard" element={<EmployeePortal />} />
          <Route path="/verificar" element={<PublicDocumentVerification />} />
          <Route path="/verificar/:codigo" element={<PublicDocumentVerification />} />
          <Route path="/verificar-ponto" element={<PublicPunchVerification />} />
          <Route path="/verificar-ponto/:codigo" element={<PublicPunchVerification />} />
          <Route path="/admissao/:token" element={<AdmissionWizard />} />
          <Route path="/403" element={<AccessDenied403 />} />
          
          {/* Rotas Administrativas protegidas */}
          <Route element={<ProtectedRoute />}>
            <Route element={
              <CompanyProvider>
                <DashboardLayout />
              </CompanyProvider>
            }>
              <Route path="/dashboard" element={<Dashboard />} />
              
              {/* Empresas */}
              <Route element={<RequirePermission permission="manage_companies" />}>
                <Route path="/empresas" element={<CompaniesList />} />
                <Route path="/empresas/nova" element={<CompanyForm />} />
                <Route path="/empresas/:id" element={<CompanyForm />} />
              </Route>
              
              {/* Estrutura Organizacional */}
              <Route element={<RequirePermission permission="manage_org_structure" />}>
                <Route path="/departamentos" element={<DepartmentsList />} />
                <Route path="/departamentos/novo" element={<DepartmentForm />} />
                <Route path="/departamentos/:id" element={<DepartmentForm />} />

                <Route path="/setores" element={<SectorsList />} />
                <Route path="/setores/novo" element={<SectorForm />} />
                <Route path="/setores/:id" element={<SectorForm />} />

                <Route path="/cargos" element={<PositionsList />} />
                <Route path="/cargos/novo" element={<PositionForm />} />
                <Route path="/cargos/:id" element={<PositionForm />} />

                <Route path="/tipos-de-contrato" element={<ContractTypesList />} />
                <Route path="/tipos-de-contrato/novo" element={<ContractTypeForm />} />
                <Route path="/tipos-de-contrato/:id" element={<ContractTypeForm />} />

                <Route path="/sindicatos" element={<UnionsList />} />

                <Route path="/centros-de-custo" element={<CostCentersList />} />
                <Route path="/centros-de-custo/novo" element={<CostCenterForm />} />
                <Route path="/centros-de-custo/:id" element={<CostCenterForm />} />

                <Route path="/lotacoes" element={<WorkplacesList />} />
                <Route path="/lotacoes/nova" element={<WorkplaceForm />} />
                <Route path="/lotacoes/:id" element={<WorkplaceForm />} />
              </Route>

              {/* Colaboradores e Movimentações */}
              <Route element={<RequirePermission permission="view_employees" />}>
                <Route path="/admissoes" element={<AdmissionManagement />} />
                <Route path="/funcionarios" element={<EmployeesList />} />
                <Route path="/funcionarios/novo" element={<EmployeeProfile />} />
                <Route path="/funcionarios/:id" element={<EmployeeProfile />} />
                <Route path="/funcionarios/movimentacoes" element={<Movements />} />
              </Route>
              
              {/* Desligamentos */}
              <Route element={<RequirePermission permission="manage_terminations" />}>
                <Route path="/desligamentos" element={<TerminationsList />} />
                <Route path="/desligamentos/novo" element={<OffboardingWizard />} />
              </Route>
              
              {/* Ponto Eletrônico */}
              <Route element={<RequirePermission permission="view_time_tracking" />}>
                <Route path="/ponto/gestao" element={<TimeManagement />} />
                <Route path="/ponto/gestao/:tab" element={<TimeManagement />} />
                <Route path="/ponto/espelho" element={<Timesheet />} />
              </Route>
              <Route element={<RequirePermission permission="manage_time_tracking" />}>
                <Route path="/jornadas" element={<WorkSchedulesList />} />
                <Route path="/jornadas/nova" element={<WorkScheduleForm />} />
                <Route path="/jornadas/:id" element={<WorkScheduleForm />} />
                <Route path="/feriados" element={<HolidaysList />} />
                <Route path="/feriados/novo" element={<HolidayForm />} />
                <Route path="/feriados/:id" element={<HolidayForm />} />
              </Route>
              
              {/* Férias */}
              <Route element={<RequirePermission permission="manage_vacations" />}>
                <Route path="/ferias" element={<VacationsList />} />
                <Route path="/ferias/novo" element={<VacationWizard />} />
              </Route>

              {/* Afastamentos */}
              <Route element={<RequirePermission permission="manage_leaves" />}>
                <Route path="/afastamentos" element={<LeavesList />} />
                <Route path="/afastamentos/novo" element={<LeaveWizard />} />
                <Route path="/afastamentos/:id" element={<LeaveWizard />} />
              </Route>

              {/* Benefícios */}
              <Route element={<RequirePermission permission="manage_benefits" />}>
                <Route path="/beneficios" element={<BenefitsList />} />
                <Route path="/beneficios/novo" element={<BenefitForm />} />
              </Route>
              
              {/* Folha de Pagamento */}
              <Route element={<RequirePermission permission="calculate_payroll" />}>
                <Route path="/folha/processamento" element={<PayrollCalculations />} />
              </Route>
              <Route element={<RequirePermission permission="manage_payroll_events" />}>
                <Route path="/folha/lancamentos" element={<PayrollEvents />} />
              </Route>
              <Route element={<RequirePermission permission="view_payslips" />}>
                <Route path="/folha/holerites" element={<Payslips />} />
              </Route>
              <Route element={<RequirePermission permission="manage_rubrics" />}>
                <Route path="/folha/rubricas" element={<PayrollRubrics />} />
              </Route>
              <Route element={<RequirePermission permission="view_payroll_accounting" />}>
                <Route path="/folha/relatorios" element={<PayrollReports />} />
                <Route path="/contabilidade" element={<AccountingHub />} />
              </Route>

              {/* Aprovações da Equipe (Gestor -> DP) */}
              <Route element={<RequirePermission permission={['approve_team_requests', 'manage_time_tracking', 'manage_vacations']} />}>
                <Route path="/aprovacoes" element={<ManagerApprovals />} />
              </Route>
              
              {/* eSocial & SST */}
              <Route element={<RequirePermission permission="manage_esocial" />}>
                <Route path="/esocial" element={<ESocialDashboard />} />
              </Route>
              <Route element={<RequirePermission permission="view_sst" />}>
                <Route path="/sst" element={<SstDashboard />} />
              </Route>
              
              {/* Documentos */}
              <Route element={<RequirePermission permission="manage_documents" />}>
                <Route path="/documentos/templates" element={<Templates />} />
                <Route path="/documentos/cofre" element={<SignaturesVault />} />
                <Route path="/documentos/recepcao" element={<PersonalDocsInbox />} />
              </Route>
              
              {/* Auditoria & Configurações */}
              <Route element={<RequirePermission permission={['manage_settings', 'calculate_payroll']} />}>
                <Route path="/implantacao" element={<DataImport />} />
              </Route>
              <Route element={<RequirePermission permission="view_audit_logs" />}>
                <Route path="/auditoria" element={<LogViewer />} />
              </Route>
              <Route element={<RequirePermission permission={['manage_settings', 'manage_roles']} />}>
                <Route path="/configuracoes" element={<SettingsDashboard />} />
              </Route>
              <Route element={<RequirePermission permission="manage_legal_parameters" />}>
                <Route path="/configuracoes/tabelas-legais" element={<LegalTablesList />} />
                <Route path="/configuracoes/tabelas-legais/nova" element={<LegalTablesForm />} />
                <Route path="/configuracoes/tabelas-legais/:id" element={<LegalTablesForm />} />
              </Route>

              {/* Ajuda */}
              <Route path="/ajuda" element={<Help />} />
            </Route>
          </Route>
          
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
