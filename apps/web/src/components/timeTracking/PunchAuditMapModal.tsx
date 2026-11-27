import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, ShieldAlert, X, CheckCircle2, Navigation } from 'lucide-react';
import type { PunchAuditRecord } from '../../services/timeTracking/pontoEnterpriseService';

interface PunchAuditMapModalProps {
  punch: PunchAuditRecord | null;
  onClose: () => void;
}

export const PunchAuditMapModal: React.FC<PunchAuditMapModalProps> = ({ punch, onClose }) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!punch || !mapContainerRef.current) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const pLat = punch.latitude ?? punch.workplace_latitude ?? -23.55052;
    const pLon = punch.longitude ?? punch.workplace_longitude ?? -46.633308;

    const map = L.map(mapContainerRef.current).setView([pLat, pLon], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    if (punch.workplace_latitude !== null && punch.workplace_longitude !== null) {
      const radius = Number(punch.workplace_radius_meters || 100);
      L.circle([punch.workplace_latitude, punch.workplace_longitude], {
        radius,
        color: '#2563eb',
        fillColor: '#3b82f6',
        fillOpacity: 0.15,
      })
        .addTo(map)
        .bindPopup(`Local Autorizado: ${punch.workplace_name || 'Lotação'} (Raio ${radius}m)`);

      L.circleMarker([punch.workplace_latitude, punch.workplace_longitude], {
        radius: 6,
        color: '#1d4ed8',
        fillColor: '#1d4ed8',
        fillOpacity: 1,
      }).addTo(map);
    }

    if (punch.latitude !== null && punch.longitude !== null) {
      const isFlagged = (punch.fraud_flags && punch.fraud_flags.length > 0) || punch.geofence_status === 'OUTSIDE' || punch.geofence_status === 'SPOOF_SUSPECT';
      L.circleMarker([punch.latitude, punch.longitude], {
        radius: 9,
        color: isFlagged ? '#dc2626' : '#059669',
        fillColor: isFlagged ? '#ef4444' : '#10b981',
        fillOpacity: 0.9,
      })
        .addTo(map)
        .bindPopup(
          `<b>Batida:</b> ${punch.worker_name}<br/><b>Status:</b> ${punch.geofence_status}<br/><b>Distância:</b> ${punch.distance_meters ?? 'N/A'}m`
        )
        .openPopup();
    }

    if (
      punch.latitude !== null &&
      punch.longitude !== null &&
      punch.workplace_latitude !== null &&
      punch.workplace_longitude !== null
    ) {
      const bounds = L.latLngBounds(
        [punch.latitude, punch.longitude],
        [punch.workplace_latitude, punch.workplace_longitude]
      );
      map.fitBounds(bounds.pad(0.4));
    }

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [punch]);

  if (!punch) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-3xl w-full overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MapPin className="text-blue-400" size={20} />
            <div>
              <h3 className="font-bold text-base">Auditoria GPS — {punch.worker_name}</h3>
              <p className="text-xs text-slate-300">
                {new Date(punch.punched_at).toLocaleString('pt-BR')} · {punch.entry_type_label} · IP {punch.ip_address || 'N/A'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border-b border-slate-200 text-xs">
          <div className="p-2.5 bg-white rounded-xl border border-slate-200">
            <span className="text-slate-400 block">Status Geofence</span>
            <strong className="text-slate-800">{punch.geofence_status}</strong>
          </div>
          <div className="p-2.5 bg-white rounded-xl border border-slate-200">
            <span className="text-slate-400 block">Distância do Local</span>
            <strong className="text-slate-800">{punch.distance_meters !== null ? `${punch.distance_meters} m` : 'N/A'}</strong>
          </div>
          <div className="p-2.5 bg-white rounded-xl border border-slate-200">
            <span className="text-slate-400 block">Acurácia GPS</span>
            <strong className="text-slate-800">{punch.accuracy !== null ? `${punch.accuracy} m` : 'N/A'}</strong>
          </div>
          <div className="p-2.5 bg-white rounded-xl border border-slate-200">
            <span className="text-slate-400 block">Origem / Velocidade</span>
            <strong className="text-slate-800">
              {punch.sync_origin} {punch.speed_kmh ? `(${punch.speed_kmh} km/h)` : ''}
            </strong>
          </div>
        </div>

        {punch.fraud_flags && punch.fraud_flags.length > 0 ? (
          <div className="px-6 py-2.5 bg-red-50 border-b border-red-200 flex items-center gap-2 text-xs text-red-800 font-semibold">
            <ShieldAlert size={16} />
            Flags Anti-Spoofing detectadas: {punch.fraud_flags.join(', ')}
          </div>
        ) : (
          <div className="px-6 py-2 bg-emerald-50 border-b border-emerald-200 flex items-center gap-2 text-xs text-emerald-800 font-semibold">
            <CheckCircle2 size={15} />
            Nenhum indício de fraude ou spoofing GPS nesta batida.
          </div>
        )}

        <div ref={mapContainerRef} className="w-full h-[360px] bg-slate-100" />

        <div className="px-6 py-3 bg-white border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <Navigation size={14} className="text-blue-600" />
            Círculo azul: raio autorizado ({punch.workplace_radius_meters || 100}m) · Marcador: posição da batida
          </span>
          {punch.selfie_signed_url && (
            <a
              href={punch.selfie_signed_url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 font-semibold hover:underline"
            >
              Visualizar Selfie (Storage Privado)
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
