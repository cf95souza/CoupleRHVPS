export interface WorkplaceGeofenceConfig {
  name: string;
  latitude: number | null;
  longitude: number | null;
  radius_meters: number;
  enforce_geofence: boolean;
}

export type GeofenceStatus =
  | 'INSIDE'
  | 'OUTSIDE'
  | 'TELEWORK'
  | 'AUDIT_ONLY'
  | 'NO_GPS'
  | 'NO_CONFIG'
  | 'SPOOF_SUSPECT';

export interface GeofenceValidationResult {
  isAllowed: boolean;
  status: GeofenceStatus;
  distanceMeters: number | null;
  allowedRadiusMeters: number;
  message: string;
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

  // Anti-spoofing: deteccao explicita de GPS simulado
  if (isMockGps) {
    return {
      isAllowed: false,
      status: 'SPOOF_SUSPECT',
      distanceMeters: null,
      allowedRadiusMeters: workplace?.radius_meters || 0,
      message: 'Bloqueio de seguranca: localizacao simulada detectada pelo dispositivo.'
    };
  }

  // Regime de Teletrabalho / Home Office dispensado de cerca fisica
  if (isTelework) {
    return {
      isAllowed: true,
      status: 'TELEWORK',
      distanceMeters: null,
      allowedRadiusMeters: workplace?.radius_meters || 0,
      message: 'Regime de Teletrabalho / Home Office: Registro autorizado em qualquer localizacao.'
    };
  }

  // Local de trabalho sem coordenadas cadastradas
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

  // Ausencia de GPS quando obrigatorio
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