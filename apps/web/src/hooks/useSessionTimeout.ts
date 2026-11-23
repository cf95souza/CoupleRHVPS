import { useEffect, useRef, useCallback } from 'react';

export interface UseSessionTimeoutOptions {
  timeoutMinutes?: number;
  heartbeatIntervalMinutes?: number;
  onTimeout?: () => void;
  onHeartbeat?: () => Promise<void> | void;
}

/**
 * Hook para monitoramento de inatividade e encerramento automático de sessão (CLT / Enterprise)
 * Envia heartbeats periódicos durante uso e dispara logout quando inativo
 */
export function useSessionTimeout({
  timeoutMinutes = 60,
  heartbeatIntervalMinutes = 5,
  onTimeout,
  onHeartbeat,
}: UseSessionTimeoutOptions = {}) {
  const lastActivityRef = useRef<number>(Date.now());
  const lastHeartbeatRef = useRef<number>(Date.now());
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const heartbeatMs = heartbeatIntervalMinutes * 60 * 1000;

  const handleUserActivity = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;

    // Dispara heartbeat com throttling se houver atividade e intervalo decorrido
    if (now - lastHeartbeatRef.current >= heartbeatMs) {
      lastHeartbeatRef.current = now;
      if (onHeartbeat) {
        Promise.resolve(onHeartbeat()).catch(() => {
          // Falha de rede transitória no heartbeat não deve crashar
        });
      }
    }
  }, [heartbeatMs, onHeartbeat]);

  useEffect(() => {
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];

    const onEvent = () => handleUserActivity();

    events.forEach((event) => {
      window.addEventListener(event, onEvent, { passive: true });
    });

    // Timer de verificação de inatividade a cada 30 segundos
    const checkInterval = setInterval(() => {
      const inactiveDuration = Date.now() - lastActivityRef.current;
      if (inactiveDuration >= timeoutMs) {
        if (onTimeout) {
          onTimeout();
        }
      }
    }, 30_000);

    return () => {
      events.forEach((event) => {
        window.removeEventListener(event, onEvent);
      });
      clearInterval(checkInterval);
    };
  }, [handleUserActivity, timeoutMs, onTimeout]);

  return {
    getLastActivity: () => lastActivityRef.current,
  };
}
