import React, { useState, useEffect } from 'react';
import {
  Clock,
  MapPin,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
  ShieldCheck,
  ShieldAlert,
  Download,
  Camera,
  WifiOff,
  Navigation,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  validateAntiSpoofingAndMultiGeofence,
  type AllowedWorkplaceConfig,
  type AntiSpoofingGeoResult,
} from '@couplerh/payroll-core';
import {
  enqueueOfflinePunch,
  listOfflinePunches,
  syncOfflinePunches,
} from '../../lib/offlinePunchQueue';
import { pontoEnterpriseService } from '../../services/timeTracking/pontoEnterpriseService';

interface TimePunchModalProps {
  isOpen: boolean;
  onClose: () => void;
  contractId: string;
  workerName: string;
  workerCpf: string;
  companyName: string;
  companyCnpj: string;
  onPunchSuccess?: () => void;
}

interface PunchReceipt {
  punch_id: string;
  nsr: number;
  punched_at: string;
  receipt_code: string;
  entry_type: string;
  entry_type_label: string;
  sha256_hash: string;
  qr_code_data_url?: string;
  verification_url?: string;
  offline_queued?: boolean;
  geofence_status?: string;
}

export const TimePunchModal: React.FC<TimePunchModalProps> = ({
  isOpen,
  onClose,
  contractId,
  workerName,
  workerCpf,
  companyName,
  companyCnpj,
  onPunchSuccess,
}) => {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [entryType, setEntryType] = useState<'ENTRY' | 'INTERVAL_START' | 'INTERVAL_END' | 'EXIT'>('ENTRY');
  const [loading, setLoading] = useState(false);
  const [geoState, setGeoState] = useState<{
    latitude: number | null;
    longitude: number | null;
    accuracy: number | null;
    error: string | null;
    loading: boolean;
  }>({
    latitude: null,
    longitude: null,
    accuracy: null,
    error: null,
    loading: true,
  });
  const [receipt, setReceipt] = useState<PunchReceipt | null>(null);

  const [workplaces, setWorkplaces] = useState<AllowedWorkplaceConfig[]>([]);
  const [isTelework, setIsTelework] = useState(false);
  const [geofenceResult, setGeofenceResult] = useState<AntiSpoofingGeoResult | null>(null);
  const [geofenceLoading, setGeofenceLoading] = useState(true);

  // Selfie opcional LGPD
  const [selfieConsentActive, setSelfieConsentActive] = useState(false);
  const [selfieBase64, setSelfieBase64] = useState<string | null>(null);
  const [pendingOfflineCount, setPendingOfflineCount] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !contractId) return;
    let mounted = true;
    setGeofenceLoading(true);
    setSelfieBase64(null);

    Promise.all([
      pontoEnterpriseService.fetchPortalWorkplaces().catch(() => ({ isTelework: false, workplaces: [] })),
      pontoEnterpriseService.fetchLgpdConsents().catch(() => []),
      listOfflinePunches().catch(() => []),
    ])
      .then(([wpRes, consents, offlineQueue]) => {
        if (!mounted) return;
        setIsTelework(Boolean(wpRes?.isTelework));
        setWorkplaces(
          (wpRes?.workplaces || []).map((w: any) => ({
            id: w.id,
            name: w.name,
            latitude: w.latitude !== null ? Number(w.latitude) : null,
            longitude: w.longitude !== null ? Number(w.longitude) : null,
            radius_meters: Number(w.radius_meters || 50),
            enforce_geofence: Boolean(w.enforce_geofence),
            max_accuracy_meters: Number(w.max_accuracy_meters || 150),
            allow_external_audit: Boolean(w.allow_external_audit),
          }))
        );
        const hasSelfieConsent = (consents || []).some(
          (c: any) => c.consent_category === 'BIOMETRIC_SELFIE_PUNCH' && c.granted && !c.revoked_at
        );
        setSelfieConsentActive(hasSelfieConsent);
        setPendingOfflineCount(offlineQueue.length);
      })
      .finally(() => {
        if (mounted) setGeofenceLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen, contractId]);

  useEffect(() => {
    if (!isOpen) {
      setReceipt(null);
      return;
    }

    if (!navigator.geolocation) {
      setGeoState({
        latitude: null,
        longitude: null,
        accuracy: null,
        error: 'Geolocalização não suportada neste dispositivo.',
        loading: false,
      });
      return;
    }

    setGeoState((prev) => ({ ...prev, loading: true, error: null }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoState({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          error: null,
          loading: false,
        });
      },
      () => {
        setGeoState({
          latitude: null,
          longitude: null,
          accuracy: null,
          error: 'Permissão de GPS negada ou indisponível.',
          loading: false,
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }, [isOpen]);

  useEffect(() => {
    if (geofenceLoading || geoState.loading) return;
    const result = validateAntiSpoofingAndMultiGeofence({
      userLat: geoState.latitude,
      userLon: geoState.longitude,
      userAccuracy: geoState.accuracy,
      workplaces,
      isTelework,
    });
    setGeofenceResult(result);
  }, [geoState, workplaces, isTelework, geofenceLoading]);

  if (!isOpen) return null;

  const handleSelfieSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setSelfieBase64(String(reader.result || ''));
    };
    reader.readAsDataURL(file);
  };

  const handleSyncOfflineNow = async () => {
    try {
      const res = await syncOfflinePunches((punches) => pontoEnterpriseService.syncOfflinePunches(punches));
      setPendingOfflineCount(res.remaining);
      if (res.synced > 0) {
        toast.success(`${res.synced} batida(s) offline sincronizada(s) com o servidor!`);
        if (onPunchSuccess) onPunchSuccess();
      }
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao sincronizar fila offline.');
    }
  };

  const handleRegisterPunch = async () => {
    if (!contractId) {
      toast.error('Contrato de trabalho não identificado.');
      return;
    }

    setLoading(true);
    const clientUuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const deviceTimestamp = new Date().toISOString();

    const queueOfflineFallback = async () => {
      await enqueueOfflinePunch({
        clientUuid,
        punchType: entryType,
        latitude: geoState.latitude,
        longitude: geoState.longitude,
        accuracy: geoState.accuracy,
        isMockLocation: false,
        deviceFingerprint: navigator.userAgent,
        deviceTimestamp,
        selfieBase64,
        selfieMimeType: 'image/jpeg',
        createdAt: deviceTimestamp,
      });
      const queue = await listOfflinePunches();
      setPendingOfflineCount(queue.length);
      setReceipt({
        punch_id: clientUuid,
        nsr: 0,
        punched_at: deviceTimestamp,
        receipt_code: `OFFLINE-${clientUuid.slice(0, 8).toUpperCase()}`,
        entry_type: entryType,
        entry_type_label: getEntryLabel(entryType),
        sha256_hash: 'AGUARDANDO_SINCRONIZACAO_OFFLINE_PWA',
        offline_queued: true,
      });
      toast.warning('Sem conexão: batida salva com segurança na fila offline PWA.');
    };

    try {
      if (!navigator.onLine) {
        await queueOfflineFallback();
        return;
      }

      const data = await pontoEnterpriseService.registerPunch({
        punchType: entryType,
        latitude: geoState.latitude,
        longitude: geoState.longitude,
        accuracy: geoState.accuracy,
        isMockLocation: false,
        deviceFingerprint: navigator.userAgent,
        deviceTimestamp,
        syncOrigin: 'ONLINE_API',
        clientUuid,
        selfieBase64: selfieBase64 || undefined,
        selfieMimeType: 'image/jpeg',
      });

      setReceipt({
        punch_id: data.punch_id || data.id,
        nsr: Number(data.nsr || 0),
        punched_at: data.punched_at,
        receipt_code: data.receipt_code,
        entry_type: data.punch_type || entryType,
        entry_type_label: data.entry_type_label || getEntryLabel(entryType),
        sha256_hash: data.sha256_hash,
        qr_code_data_url: data.qr_code_data_url,
        verification_url: data.verification_url,
        geofence_status: data.geofence_status,
      });
      toast.success('Ponto registrado no servidor! Comprovante REP-P emitido.');
      if (onPunchSuccess) onPunchSuccess();
    } catch (err: any) {
      const isNetworkErr = !navigator.onLine || String(err?.message || '').includes('Failed to fetch');
      if (isNetworkErr) {
        await queueOfflineFallback();
      } else {
        toast.error(err?.message || 'Erro ao registrar ponto.');
      }
    } finally {
      setLoading(false);
    }
  };

  const getEntryLabel = (type: string) => {
    switch (type) {
      case 'ENTRY':
        return 'Entrada';
      case 'INTERVAL_START':
        return 'Saída Almoço';
      case 'INTERVAL_END':
        return 'Retorno Almoço';
      case 'EXIT':
        return 'Saída';
      default:
        return 'Marcação';
    }
  };

  const formattedHours = String(currentTime.getHours()).padStart(2, '0');
  const formattedMinutes = String(currentTime.getMinutes()).padStart(2, '0');
  const formattedSeconds = String(currentTime.getSeconds()).padStart(2, '0');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-100 max-w-md w-full overflow-hidden max-h-[92vh] flex flex-col">
        <div className="bg-gradient-to-r from-primary-600 to-indigo-600 px-6 py-4 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center">
              <Clock size={22} className="text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Ponto Eletrônico Enterprise</h2>
              <p className="text-xs text-white/80">REP-P · Anti-Spoofing & Offline PWA</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          {pendingOfflineCount > 0 && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-between text-xs text-amber-900">
              <span className="flex items-center gap-1.5 font-semibold">
                <WifiOff size={15} /> {pendingOfflineCount} batida(s) na fila offline
              </span>
              <button onClick={handleSyncOfflineNow} className="px-2.5 py-1 rounded-lg bg-amber-600 text-white font-bold">
                Sincronizar
              </button>
            </div>
          )}

          {!receipt ? (
            <>
              <div className="text-center bg-slate-50 border border-slate-100 rounded-2xl p-4">
                <div className="text-4xl font-black font-mono text-slate-900 flex justify-center items-baseline gap-1">
                  <span>{formattedHours}</span>:<span>{formattedMinutes}</span>:
                  <span className="text-xl text-slate-400">{formattedSeconds}</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1 flex items-center justify-center gap-1">
                  <ShieldCheck size={13} className="text-emerald-500" />
                  Validação server-side de contrato, debounce 60s e precisão GPS
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs px-3 py-2 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-slate-600 flex items-center gap-1.5 font-medium">
                    <Navigation size={14} className={geoState.latitude ? 'text-primary-600' : 'text-slate-400'} />
                    {geoState.loading
                      ? 'Obtendo GPS...'
                      : geoState.latitude
                        ? `GPS ±${geoState.accuracy}m (${workplaces.length} local(is))`
                        : geoState.error || 'Sem GPS'}
                  </span>
                  {geofenceResult && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        geofenceResult.isAllowed ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                      }`}
                    >
                      {geofenceResult.status}
                    </span>
                  )}
                </div>
                {geofenceResult && (
                  <p className="text-[11px] text-slate-500 px-1 flex items-center gap-1">
                    <MapPin size={12} /> {geofenceResult.message}
                  </p>
                )}
              </div>

              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2 block">
                  Tipo de Marcação
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'ENTRY', label: 'Entrada' },
                    { id: 'INTERVAL_START', label: 'Saída Almoço' },
                    { id: 'INTERVAL_END', label: 'Retorno Almoço' },
                    { id: 'EXIT', label: 'Saída' },
                  ].map((btn) => (
                    <button
                      key={btn.id}
                      type="button"
                      onClick={() => setEntryType(btn.id as any)}
                      className={`py-2.5 px-3 rounded-xl text-xs font-bold border ${
                        entryType === btn.id
                          ? 'bg-primary-50 border-primary-500 text-primary-700'
                          : 'bg-white border-slate-200 text-slate-600'
                      }`}
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
              </div>

              {selfieConsentActive && (
                <div className="p-3 bg-indigo-50/70 border border-indigo-200 rounded-xl space-y-2">
                  <label className="text-xs font-bold text-indigo-900 flex items-center gap-1.5">
                    <Camera size={14} /> Selfie Opcional (Consentimento LGPD Ativo)
                  </label>
                  <input type="file" accept="image/*" capture="user" onChange={handleSelfieSelected} className="text-xs w-full" />
                </div>
              )}

              {(() => {
                const blocked = geofenceResult ? !geofenceResult.isAllowed : false;
                const waiting = geoState.loading || geofenceLoading;
                return (
                  <button
                    onClick={handleRegisterPunch}
                    disabled={loading || blocked || waiting}
                    className={`w-full py-3.5 rounded-2xl font-extrabold text-sm flex items-center justify-center gap-2 ${
                      blocked
                        ? 'bg-rose-100 text-rose-700 cursor-not-allowed'
                        : 'bg-gradient-to-r from-primary-600 to-indigo-600 text-white shadow-lg disabled:opacity-50'
                    }`}
                  >
                    {loading ? (
                      <>
                        <Loader2 size={18} className="animate-spin" /> Registrando...
                      </>
                    ) : waiting ? (
                      <>
                        <Loader2 size={18} className="animate-spin" /> Validando GPS...
                      </>
                    ) : blocked ? (
                      <>
                        <ShieldAlert size={18} /> Bloqueado pela Cerca / Anti-Spoofing
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={18} /> Confirmar ({getEntryLabel(entryType)})
                      </>
                    )}
                  </button>
                );
              })()}
            </>
          ) : (
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-2 font-mono text-[11px]">
                <div className="text-center border-b border-slate-200 pb-2">
                  <p className="font-bold text-xs">COMPROVANTE REP-P · PORTARIA MTP 671/2021</p>
                </div>
                <p>EMPREGADOR: {companyName} ({companyCnpj})</p>
                <p>EMPREGADO: {workerName} ({workerCpf})</p>
                <p className="font-bold text-primary-700">TIPO: {receipt.entry_type_label}</p>
                <p>DATA/HORA: {new Date(receipt.punched_at).toLocaleString('pt-BR')}</p>
                <p>NSR: {receipt.offline_queued ? 'PENDENTE (OFFLINE PWA)' : String(receipt.nsr).padStart(9, '0')}</p>
                <p>RECIBO: {receipt.receipt_code}</p>
                <p className="break-all text-[9px] text-slate-500">SHA-256: {receipt.sha256_hash}</p>

                {receipt.qr_code_data_url ? (
                  <div className="pt-2 flex flex-col items-center">
                    <img src={receipt.qr_code_data_url} alt="QR Code Verificação REP-P" className="w-32 h-32 rounded-lg border" />
                    <a
                      href={`/verificar-ponto/${receipt.receipt_code}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 text-[10px] text-blue-600 font-sans font-semibold hover:underline flex items-center gap-1"
                    >
                      Conferência Pública (Sem CPF na URL) <ExternalLink size={11} />
                    </a>
                  </div>
                ) : (
                  <div className="p-2 bg-amber-100 rounded text-amber-900 font-sans text-[11px] flex items-center gap-1.5">
                    <AlertTriangle size={14} /> Comprovante definitivo com QR Code será emitido ao sincronizar.
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => window.print()}
                  className="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 text-slate-700 font-bold text-xs flex items-center justify-center gap-1.5"
                >
                  <Download size={15} /> Imprimir
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-primary-600 text-white font-bold text-xs"
                >
                  Concluir
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TimePunchModal;
