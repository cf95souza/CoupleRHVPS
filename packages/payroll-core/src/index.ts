// Utilitarios e Catalogo Unico de Variaveis
export * from './utils/money.js';
export * from './utils/numberToWordsPtBr.js';
export * from './variablesCatalog.js';

// Rubricas e Formulas
export * from './rubrics/DAGResolver.js';
export * from './rubrics/RubricFormulaParser.js';

// Motor de Calculo de Folha
export * from './engine/RubricModelV2.js';
export * from './engine/PayrollContext.js';
export * from './engine/PayrollEngine.js';
export * from './engine/ThirteenthSalaryCalculator.js';
export * from './engine/VacationOverlapCalculator.js';
export * from './engine/TerminationCalculator.js';
export * from './engine/TerminationOrchestrator.js';
export * from './engine/RetroactiveDissidioCalculator.js';
export * from './engine/DependentsEligibility.js';
export * from './engine/DeductionEligibility.js';
export * from './engine/ContractAdmissionFilter.js';
export * from './engine/CompanyTaxesAggregator.js';
export * from './engine/AtomicPersistence.js';
export * from './engine/WhatIfSimulator.js';

// Modulos Legais CLT
export * from './legal/INSSCalculator.js';
export * from './legal/IRRFCalculator.js';
export * from './legal/FGTSCalculator.js';
export * from './legal/NightWorkCalculator.js';
export * from './legal/EmployerTaxesCalculator.js';
export * from './legal/LegalTableValidator.js';
export * from './legal/PaymentDateHelper.js';
export * from './legal/AlimonySolver.js';
export * from './legal/LeaveImpactCalculator.js';
export * from './legal/FamilyAllowanceCalculator.js';
export * from './legal/MultipleEmploymentINSSCalculator.js';
export * from './legal/DiscountPriorityManager.js';
export * from './legal/BenefitsCalculator.js';
export * from './legal/CollectiveAgreementCalculator.js';
export * from './legal/AveragesCalculator.js';
export * from './legal/VacationEnterpriseCalculator.js';
export * from './legal/MultiRegimeCalculator.js';

// Ponto e Jornadas
export * from './time/timeTrackingModel.js';
export * from './time/workShiftEngine.js';
export * from './time/afdParser.js';
export * from './time/geoValidator.js';

// Assinaturas Digitais e Documentos
export * from './documents/documentSignatureModel.js';

// Contabilizacao Enterprise, Rateios, Provisoes Reais, CNAB 240 e Obrigacoes (FASE V7)
export * from './accounting/CostAllocationEngine.js';
export * from './accounting/ProvisionsLedgerCalculator.js';
export * from './accounting/AccountingEngine.js';
export * from './accounting/Cnab240Engine.js';
export * from './accounting/IncomeReportEngine.js';

// eSocial Enterprise S-1.2 / S-1.3 (FASE V9)
export * from './esocial/EsocialTypes.js';
export * from './esocial/EsocialXmlGenerator.js';
export * from './esocial/EsocialXsdValidator.js';
export * from './esocial/EsocialTotalizerParser.js';