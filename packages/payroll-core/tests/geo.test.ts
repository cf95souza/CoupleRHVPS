import { describe, it, expect } from 'vitest';
import {
  calculateHaversineDistanceMeters,
  validateGeofence,
  WorkplaceGeofenceConfig
} from '../src/time/geoValidator.js';

describe('geoValidator.ts - Validacao Geodesica e Anti-Spoofing de Ponto', () => {
  const matriz: WorkplaceGeofenceConfig = {
    name: 'Sede Central',
    latitude: -23.55052,
    longitude: -46.633308,
    radius_meters: 100,
    enforce_geofence: true
  };

  it('deve calcular distancia Haversine corretamente entre dois pontos proximos', () => {
    // Ponto a ~50 metros
    const dist = calculateHaversineDistanceMeters(
      -23.55052,
      -46.633308,
      -23.55080,
      -46.633308
    );
    expect(dist).toBeGreaterThan(20);
    expect(dist).toBeLessThan(40);
  });

  it('deve autorizar ponto dentro do perimetro', () => {
    const res = validateGeofence({
      userLat: -23.55055,
      userLon: -46.63331,
      workplace: matriz
    });
    expect(res.isAllowed).toBe(true);
    expect(res.status).toBe('INSIDE');
  });

  it('deve bloquear ponto fora do perimetro quando enforce_geofence = true', () => {
    const res = validateGeofence({
      userLat: -23.56000, // ~1 km distante
      userLon: -46.633308,
      workplace: matriz
    });
    expect(res.isAllowed).toBe(false);
    expect(res.status).toBe('OUTSIDE');
  });

  it('deve autorizar teletrabalho em qualquer coordenada', () => {
    const res = validateGeofence({
      userLat: -22.9068, // Rio de Janeiro
      userLon: -43.1729,
      workplace: matriz,
      isTelework: true
    });
    expect(res.isAllowed).toBe(true);
    expect(res.status).toBe('TELEWORK');
  });

  it('deve bloquear marcacao com GPS simulado (mock spoofing)', () => {
    const res = validateGeofence({
      userLat: -23.55052,
      userLon: -46.633308,
      isMockGps: true,
      workplace: matriz
    });
    expect(res.isAllowed).toBe(false);
    expect(res.status).toBe('SPOOF_SUSPECT');
  });
});