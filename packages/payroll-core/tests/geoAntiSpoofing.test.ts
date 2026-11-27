import { describe, it, expect } from 'vitest';
import { validateAntiSpoofingAndMultiGeofence } from '../src/index.js';

describe('geoAntiSpoofing (PONTO-01 e PONTO-02)', () => {
  const matriz = {
    id: 'wp-1',
    name: 'Matriz SP',
    latitude: -23.55052,
    longitude: -46.633308,
    radius_meters: 100,
    enforce_geofence: true,
    max_accuracy_meters: 150,
  };

  const filial = {
    id: 'wp-2',
    name: 'Filial Paulista',
    latitude: -23.561414,
    longitude: -46.655881,
    radius_meters: 120,
    enforce_geofence: true,
    max_accuracy_meters: 150,
  };

  it('1. Deve autorizar batida dentro do 2º local permitido para o contrato', () => {
    const res = validateAntiSpoofingAndMultiGeofence({
      userLat: -23.5615,
      userLon: -46.6559,
      userAccuracy: 18,
      workplaces: [matriz, filial],
    });
    expect(res.isAllowed).toBe(true);
    expect(res.status).toBe('INSIDE');
    expect(res.matchedWorkplaceId).toBe('wp-2');
    expect(res.fraudFlags).toHaveLength(0);
  });

  it('2. Deve bloquear isMockGps e accuracy === 0 em cerca ativa', () => {
    const mockRes = validateAntiSpoofingAndMultiGeofence({
      userLat: -23.55052,
      userLon: -46.633308,
      userAccuracy: 12,
      isMockGps: true,
      workplaces: [matriz],
    });
    expect(mockRes.isAllowed).toBe(false);
    expect(mockRes.status).toBe('SPOOF_SUSPECT');
    expect(mockRes.fraudFlags).toContain('MOCK_GPS');

    const zeroAccRes = validateAntiSpoofingAndMultiGeofence({
      userLat: -23.55052,
      userLon: -46.633308,
      userAccuracy: 0,
      isMockGps: false,
      workplaces: [matriz],
    });
    expect(zeroAccRes.isAllowed).toBe(false);
    expect(zeroAccRes.status).toBe('SPOOF_SUSPECT');
    expect(zeroAccRes.fraudFlags).toContain('ZERO_ACCURACY');
  });

  it('3. Deve detectar teletransporte (> 120 km/h) e baixa acurácia (> 150m)', () => {
    const res = validateAntiSpoofingAndMultiGeofence({
      userLat: -23.561414,
      userLon: -46.655881,
      userAccuracy: 240,
      workplaces: [{ ...filial, enforce_geofence: false, allow_external_audit: true }],
      previousPunch: {
        latitude: -22.9068, // Rio de Janeiro (~357km)
        longitude: -43.1729,
        punchedAt: '2026-10-10T10:00:00.000Z',
      },
      currentTimestamp: '2026-10-10T10:30:00.000Z', // 30 min depois -> ~715 km/h
    });

    expect(res.isAllowed).toBe(true);
    expect(res.status).toBe('SPOOF_SUSPECT');
    expect(res.fraudFlags).toContain('LOW_ACCURACY');
    expect(res.fraudFlags).toContain('IMPOSSIBLE_SPEED');
    expect(res.speedKmh!).toBeGreaterThan(120);
  });
});
