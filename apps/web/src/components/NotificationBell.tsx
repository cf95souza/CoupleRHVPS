import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  CheckCheck,
  RefreshCw,
  AlertTriangle,
  Info,
  AlertCircle,
  ExternalLink,
  Clock,
  Sparkles
} from 'lucide-react';
import { notificationService, UserNotification } from '../services/notificationService';

export function NotificationBell() {
  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'unread'>('unread');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Carrega contagem inicial de não lidas e atualiza a cada 30 segundos
  const fetchCount = async () => {
    try {
      const count = await notificationService.getUnreadCount();
      setUnreadCount(count);
    } catch {
      // Falha silenciosa no polling
    }
  };

  const fetchList = async (tab = activeTab) => {
    setLoading(true);
    try {
      const data = await notificationService.getNotifications({
        limit: 30,
        onlyUnread: tab === 'unread',
      });
      setNotifications(data);
    } catch (err) {
      console.error('Erro ao carregar notificações:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCount();
    const interval = setInterval(fetchCount, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchList(activeTab);
    }
  }, [isOpen, activeTab]);

  // Fechar dropdown ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleMarkAsRead = async (n: UserNotification) => {
    if (!n.read_at) {
      await notificationService.markAsRead(n.id);
      setUnreadCount((prev) => Math.max(0, prev - 1));
      setNotifications((prev) =>
        prev.map((item) => (item.id === n.id ? { ...item, read_at: new Date().toISOString() } : item))
      );
    }
    if (n.action_url) {
      setIsOpen(false);
      navigate(n.action_url);
    }
  };

  const handleMarkAllAsRead = async () => {
    await notificationService.markAllAsRead();
    setUnreadCount(0);
    setNotifications((prev) =>
      prev.map((item) => ({ ...item, read_at: new Date().toISOString() }))
    );
    if (activeTab === 'unread') {
      setNotifications([]);
    }
  };

  const handleTriggerScan = async () => {
    setScanning(true);
    try {
      await notificationService.triggerScan();
      await fetchCount();
      await fetchList(activeTab);
    } catch (err) {
      console.error('Erro ao executar varredura de alertas:', err);
    } finally {
      setScanning(false);
    }
  };

  const getSeverityIcon = (sev: string) => {
    switch (sev) {
      case 'DANGER':
        return <AlertCircle size={16} className="text-rose-500 shrink-0" />;
      case 'WARNING':
        return <AlertTriangle size={16} className="text-amber-500 shrink-0" />;
      default:
        return <Info size={16} className="text-primary-500 shrink-0" />;
    }
  };

  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  return (
    <div className="relative z-50" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors relative cursor-pointer"
        title="Notificações e Alertas"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full shadow-sm animate-pulse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-80 sm:w-96 bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in slide-in-from-top-2">
          {/* Header */}
          <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-primary-400" />
              <h3 className="text-sm font-bold tracking-tight">Notificações & Alertas</h3>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleTriggerScan}
                disabled={scanning}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                title="Executar varredura de passivos trabalhistas agora"
              >
                <RefreshCw size={13} className={scanning ? 'animate-spin text-primary-400' : ''} />
              </button>
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllAsRead}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                  title="Marcar todas como lidas"
                >
                  <CheckCheck size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Abas */}
          <div className="flex border-b border-slate-100 bg-slate-50/70 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('unread')}
              className={`flex-1 py-2 text-center border-b-2 cursor-pointer transition-colors ${
                activeTab === 'unread'
                  ? 'border-primary-600 text-primary-700 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              Não lidas ({unreadCount})
            </button>
            <button
              onClick={() => setActiveTab('all')}
              className={`flex-1 py-2 text-center border-b-2 cursor-pointer transition-colors ${
                activeTab === 'all'
                  ? 'border-primary-600 text-primary-700 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              Todas
            </button>
          </div>

          {/* Lista de Notificações */}
          <div className="max-h-[380px] overflow-y-auto divide-y divide-slate-100">
            {loading ? (
              <div className="py-8 text-center text-xs text-slate-400">
                <RefreshCw size={18} className="animate-spin mx-auto mb-2 text-slate-300" />
                Carregando alertas...
              </div>
            ) : notifications.length === 0 ? (
              <div className="py-10 text-center px-4">
                <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-2">
                  <CheckCheck size={20} />
                </div>
                <p className="text-xs font-semibold text-slate-600">Tudo em dia!</p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Nenhum alerta pendente no momento.
                </p>
              </div>
            ) : (
              notifications.map((item) => (
                <div
                  key={item.id}
                  onClick={() => handleMarkAsRead(item)}
                  className={`p-3.5 flex gap-3 transition-colors cursor-pointer group ${
                    !item.read_at ? 'bg-primary-50/40 hover:bg-primary-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="mt-0.5">{getSeverityIcon(item.severity)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1 mb-0.5">
                      <h4
                        className={`text-xs truncate ${
                          !item.read_at ? 'font-bold text-slate-900' : 'font-semibold text-slate-700'
                        }`}
                      >
                        {item.title}
                      </h4>
                      {!item.read_at && (
                        <span className="w-2 h-2 rounded-full bg-primary-500 shrink-0 mt-1" />
                      )}
                    </div>
                    <p className="text-[11px] text-slate-600 line-clamp-2 leading-relaxed">
                      {item.message}
                    </p>
                    <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400">
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        {formatTime(item.created_at)}
                      </span>
                      {item.action_url && (
                        <span className="flex items-center gap-0.5 text-primary-600 font-semibold group-hover:underline">
                          Abrir <ExternalLink size={10} />
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
