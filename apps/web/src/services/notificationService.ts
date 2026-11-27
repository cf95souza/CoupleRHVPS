import { apiClient } from '../lib/apiClient';

export interface UserNotification {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'DANGER';
  category: string;
  action_url?: string | null;
  read_at?: string | null;
  created_at: string;
}

export const notificationService = {
  async getNotifications(options?: { limit?: number; onlyUnread?: boolean }): Promise<UserNotification[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.onlyUnread) params.append('onlyUnread', 'true');

    const res = await apiClient.get<{ success: boolean; data: UserNotification[] }>(
      `/api/v1/notifications?${params.toString()}`
    );
    return res.data || [];
  },

  async getUnreadCount(): Promise<number> {
    const res = await apiClient.get<{ success: boolean; data: { unreadCount: number } }>(
      '/api/v1/notifications/unread-count'
    );
    return res.data?.unreadCount || 0;
  },

  async markAsRead(id: string): Promise<boolean> {
    const res = await apiClient.patch<{ success: boolean; data: { read: boolean } }>(
      `/api/v1/notifications/${id}/read`
    );
    return res.data?.read || false;
  },

  async markAllAsRead(): Promise<number> {
    const res = await apiClient.post<{ success: boolean; data: { markedCount: number } }>(
      '/api/v1/notifications/read-all'
    );
    return res.data?.markedCount || 0;
  },

  async triggerScan(): Promise<any> {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      '/api/v1/notifications/trigger-scan'
    );
    return res.data;
  },
};
