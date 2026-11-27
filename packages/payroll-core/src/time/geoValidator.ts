export interface WorkplaceGeofenceConfig {
  name: string;
  latitude: number | null;
  longitude: number | null;
  radius_meters: number;
  enforce_geofence: boolean;
}

export interface AllowedWorkplaceConfig extends WorkplaceGeofenceConfig {
  id?: string;
  is_primary?: boolean;
  max_accuracy_meters?: number;
  allow_external_audit?: boolean;
}

export interface PreviousPunchGeo {
  latitude: number;
  longitude: number;
  punchedAt: string | Date;
}

export type GeofenceStatus =
  | 'INSIDE'
  | 'OUTSIDE'
  | 'TELEWORK'
  | 'AUDIT_ONLY'
  | 'NO_GPS'
  | 'NO_CONFIG'
  | 'SPOOF_SUSPECT';

export type FraudFlagCode =
  | 'MOCK_GPS'
  | 'ZERO_ACCURACY'
  | 'LOW_ACCURACY'
  | 'IMPOSSIBLE_SPEED'
  | 'OUTSIDE_GEOFENCE'
  | 'MISSING_GPS';

export interface GeofenceValidationResult {
  isAllowed: boolean;
  status: GeofenceStatus;
  distanceMeters: number | null;
  allowedRadiusMeters: number;
  message: string;
}

export interface AntiSpoofingGeoResult extends GeofenceValidationResult {
  matchedWorkplaceId: string | null;
  matchedWorkplaceName: string | null;
  speedKmh: number | null;
  fraudFlags: FraudFlagCode[];
}

/**
 * Calcula a distancia geodesica em metros entre duas coordenadas (Formula de Haversine)
 */
export function calculateHaversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (lat1 === lat2 && lon1 === lon2) return 0;

  const R = 6371000; // Raio medio da Terra em metros
  const toRad = (degree: number) => (degree * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

/**
 * Valida se o colaborador esta dentro do perimetro autorizado para marcacao de ponto
 */
export function validateGeofence(params: {
  userLat: number | null;
  userLon: number | null;
  userAccuracy?: number | null;
  isMockGps?: boolean;
  workplace: WorkplaceGeofenceConfig | null;
  isTelework?: boolean;
}): GeofenceValidationResult {
  const { userLat, userLon, userAccuracy, isMockGps, workplace, isTelework = false } = params;

  if (isMockGps || userAccuracy === 0) {
    return {
      isAllowed: false,
      status: 'SPOOF_SUSPECT',
      distanceMeters: null,
      allowedRadiusMeters: workplace?.radius_meters || 0,
      message: 'Bloqueio de seguranca: localizacao simulada ou precisao zerada detectada.'
    };
  }

  if (isTelework) {
    return {
      isAllowed: true,
      status: 'TELEWORK',
      distanceMeters: null,
      allowedRadiusMeters: workplace?.radius_meters || 0,
      message: 'Regime de Teletrabalho / Home Office: Registro autorizado em qualquer localizacao.'
    };
  }

  if (!workplace || workplace.latitude === null || workplace.longitude === null) {
    return {
      isAllowed: true,
      status: 'NO_CONFIG',
      distanceMeters: null,
      allowedRadiusMeters: workplace?.radius_meters || 0,
      message: 'Local de trabalho sem perimetro GPS delimitado. Registro presencial autorizado.'
    };
  }

  const radius = workplace.radius_meters || 50;

  if (userLat === null || userLon === null) {
    if (workplace.enforce_geofence) {
      return {
        isAllowed: false,
        status: 'NO_GPS',
        distanceMeters: null,
        allowedRadiusMeters: radius,
        message: 'GPS nao detectado. A empresa exige geolocalizacao ativa para confirmar a presenca fisica.'
      };
    }

    return {
      isAllowed: true,
      status: 'AUDIT_ONLY',
      distanceMeters: null,
      allowedRadiusMeters: radius,
      message: 'Ponto sem GPS registrado para posterior auditoria.'
    };
  }

  const distance = calculateHaversineDistanceMeters(
    workplace.latitude,
    workplace.longitude,
    userLat,
    userLon
  );

  const isInside = distance <= radius;

  if (workplace.enforce_geofence) {
    if (isInside) {
      return {
        isAllowed: true,
        status: 'INSIDE',
        distanceMeters: distance,
        allowedRadiusMeters: radius,
        message: 'Localizacao autorizada dentro do perimetro.'
      };
    }

    return {
      isAllowed: false,
      status: 'OUTSIDE',
      distanceMeters: distance,
      allowedRadiusMeters: radius,
      message: 'Fora do perimetro autorizado: bloqueado.'
    };
  }

  return {
    isAllowed: true,
    status: 'AUDIT_ONLY',
    distanceMeters: distance,
    allowedRadiusMeters: radius,
    message: isInside ? 'Dentro do perimetro.' : 'Fora do perimetro (auditoria).'
  };
}

/**
 * Validacao Enterprise Multi-Workplace + Anti-Spoofing (PONTO-01 e PONTO-02):
 * - Suporta 1..N locais permitidos para o contrato (contract_allowed_workplaces)
 * - Detecta isMockGps, accuracy === 0, baixa precisao (> max_accuracy_meters) e teletransporte (> 120 km/h)
 */
export function validateAntiSpoofingAndMultiGeofence(params: {
  userLat: number | null;
  userLon: number | null;
  userAccuracy?: number | null;
  isMockGps?: boolean;
  workplaces: AllowedWorkplaceConfig[];
  isTelework?: boolean;
  previousPunch?: PreviousPunchGeo | null;
  currentTimestamp?: string | Date;
  maxImpossibleSpeedKmh?: number;
}): AntiSpoofingGeoResult {
  const {
    userLat,
    userLon,
    userAccuracy = null,
    isMockGps = false,
    workplaces = [],
    isTelework = false,
    previousPunch = null,
    currentTimestamp = new Date(),
    maxImpossibleSpeedKmh = 120,
  } = params;

  const fraudFlags: FraudFlagCode[] = [];
  const enforceAny = workplaces.some((w) => w.enforce_geofence);
  const allowExternalAny = workplaces.some((w) => w.allow_external_audit);
  const maxAccuracy = workplaces.reduce((acc, w) => Math.max(acc, Number(w.max_accuracy_meters || 150)), 150);

  if (isMockGps) {
    fraudFlags.push('MOCK_GPS');
    return {
      isAllowed: false,
      status: 'SPOOF_SUSPECT',
      matchedWorkplaceId: null,
      matchedWorkplaceName: null,
      distanceMeters: null,
      allowedRadiusMeters: workplaces[0]?.radius_meters || 0,
      speedKmh: null,
      fraudFlags,
      message: 'Bloqueio de seguranca: Mock Location / GPS simulado detectado no dispositivo.',
    };
  }

  if (userAccuracy !== null && userAccuracy !== undefined) {
    if (userAccuracy === 0) {
      fraudFlags.push('ZERO_ACCURACY');
      if (enforceAny) {
        return {
          isAllowed: false,
          status: 'SPOOF_SUSPECT',
          matchedWorkplaceId: null,
          matchedWorkplaceName: null,
          distanceMeters: null,
          allowedRadiusMeters: workplaces[0]?.radius_meters || 0,
          speedKmh: null,
          fraudFlags,
          message: 'Bloqueio anti-spoofing: precisao GPS zerada (0m) invalida para localizacao real.',
        };
      }
    } else if (userAccuracy > maxAccuracy) {
      fraudFlags.push('LOW_ACCURACY');
    }
  }

  let speedKmh: number | null = null;
  if (
    userLat !== null &&
    userLon !== null &&
    previousPunch &&
    previousPunch.latitude !== null &&
    previousPunch.longitude !== null
  ) {
    const nowMs = new Date(currentTimestamp).getTime();
    const prevMs = new Date(previousPunch.punchedAt).getTime();
    const deltaHours = (nowMs - prevMs) / 3600000;
    if (Number.isFinite(deltaHours) && deltaHours > 0) {
      const distFromPrevMeters = calculateHaversineDistanceMeters(
        previousPunch.latitude,
        previousPunch.longitude,
        userLat,
        userLon
      );
      if (distFromPrevMeters > 1000) {
        speedKmh = Math.round(((distFromPrevMeters / 1000) / deltaHours) * 100) / 100;
        if (speedKmh > maxImpossibleSpeedKmh) {
          fraudFlags.push('IMPOSSIBLE_SPEED');
        }
      }
    }
  }

  if (isTelework) {
    return {
      isAllowed: true,
      status: fraudFlags.includes('IMPOSSIBLE_SPEED') ? 'SPOOF_SUSPECT' : 'TELEWORK',
      matchedWorkplaceId: workplaces[0]?.id || null,
      matchedWorkplaceName: workplaces[0]?.name || 'Teletrabalho / Externo',
      distanceMeters: null,
      allowedRadiusMeters: workplaces[0]?.radius_meters || 0,
      speedKmh,
      fraudFlags,
      message: fraudFlags.includes('IMPOSSIBLE_SPEED')
        ? `Alerta de teletransporte (${speedKmh} km/h) registrado em teletrabalho.`
        : 'Regime de Teletrabalho / Home Office autorizado.',
    };
  }

  const geoWorkplaces = workplaces.filter((w) => w.latitude !== null && w.longitude !== null);
  if (geoWorkplaces.length === 0) {
    return {
      isAllowed: true,
      status: fraudFlags.length > 0 ? 'SPOOF_SUSPECT' : 'NO_CONFIG',
      matchedWorkplaceId: workplaces[0]?.id || null,
      matchedWorkplaceName: workplaces[0]?.name || null,
      distanceMeters: null,
      allowedRadiusMeters: workplaces[0]?.radius_meters || 0,
      speedKmh,
      fraudFlags,
      message: 'Local de trabalho sem perimetro GPS delimitado. Registro autorizado para auditoria.',
    };
  }

  if (userLat === null || userLon === null) {
    fraudFlags.push('MISSING_GPS');
    if (enforceAny && !allowExternalAny) {
      return {
        isAllowed: false,
        status: 'NO_GPS',
        matchedWorkplaceId: null,
        matchedWorkplaceName: null,
        distanceMeters: null,
        allowedRadiusMeters: geoWorkplaces[0]?.radius_meters || 50,
        speedKmh,
        fraudFlags,
        message: 'GPS obrigatorio nao recebido para cerca eletronica ativa.',
      };
    }
    return {
      isAllowed: true,
      status: 'AUDIT_ONLY',
      matchedWorkplaceId: geoWorkplaces[0]?.id || null,
      matchedWorkplaceName: geoWorkplaces[0]?.name || null,
      distanceMeters: null,
      allowedRadiusMeters: geoWorkplaces[0]?.radius_meters || 50,
      speedKmh,
      fraudFlags,
      message: 'Registro sem coordenadas GPS gravado em modo auditoria.',
    };
  }

  let bestWorkplace = geoWorkplaces[0];
  let minDistance = Infinity;
  let insideWorkplace: AllowedWorkplaceConfig | null = null;

  for (const wp of geoWorkplaces) {
    const dist = calculateHaversineDistanceMeters(wp.latitude!, wp.longitude!, userLat, userLon);
    const radius = wp.radius_meters || 50;
    if (dist < minDistance) {
      minDistance = dist;
      bestWorkplace = wp;
    }
    if (dist <= radius && !insideWorkplace) {
      insideWorkplace = wp;
    }
  }

  if (insideWorkplace) {
    const matchedDist = calculateHaversineDistanceMeters(
      insideWorkplace.latitude!,
      insideWorkplace.longitude!,
      userLat,
      userLon
    );
    const hasSpeedFraud = fraudFlags.includes('IMPOSSIBLE_SPEED');
    return {
      isAllowed: true,
      status: hasSpeedFraud ? 'SPOOF_SUSPECT' : 'INSIDE',
      matchedWorkplaceId: insideWorkplace.id || null,
      matchedWorkplaceName: insideWorkplace.name,
      distanceMeters: matchedDist,
      allowedRadiusMeters: insideWorkplace.radius_meters || 50,
      speedKmh,
      fraudFlags,
      message: hasSpeedFraud
        ? `Batida dentro de "${insideWorkplace.name}", porem com alerta de velocidade impossivel (${speedKmh} km/h).`
        : `Localizacao autorizada dentro do perimetro "${insideWorkplace.name}" (${matchedDist}m).`,
    };
  }

  fraudFlags.push('OUTSIDE_GEOFENCE');
  if (enforceAny && !allowExternalAny && !bestWorkplace.allow_external_audit) {
    return {
      isAllowed: false,
      status: 'OUTSIDE',
      matchedWorkplaceId: bestWorkplace.id || null,
      matchedWorkplaceName: bestWorkplace.name,
      distanceMeters: minDistance,
      allowedRadiusMeters: bestWorkplace.radius_meters || 50,
      speedKmh,
      fraudFlags,
      message: `Fora de todos os perimetros permitidos (menor distancia: ${minDistance}m de "${bestWorkplace.name}").`,
    };
  }

  return {
    isAllowed: true,
    status: fraudFlags.includes('IMPOSSIBLE_SPEED') ? 'SPOOF_SUSPECT' : 'AUDIT_ONLY',
    matchedWorkplaceId: bestWorkplace.id || null,
    matchedWorkplaceName: bestWorkplace.name,
    distanceMeters: minDistance,
    allowedRadiusMeters: bestWorkplace.radius_meters || 50,
    speedKmh,
    fraudFlags,
    message: `Fora do perimetro ("${bestWorkplace.name}" a ${minDistance}m), registrado para auditoria externa.`,
  };
}
