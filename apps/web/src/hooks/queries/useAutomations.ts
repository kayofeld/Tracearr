import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  Automation,
  CreateAutomationInput,
  ListResponse,
  UpdateAutomationInput,
} from '@tracearr/shared';
import { toast } from 'sonner';
import { api, type AutomationListParams, type TemplateGroup } from '@/lib/api';

export const AUTOMATIONS_KEY = ['automations'];

export function useAutomations(params: AutomationListParams = {}) {
  return useQuery({
    queryKey: [...AUTOMATIONS_KEY, 'list', params],
    queryFn: () => api.automations.list(params),
    staleTime: 1000 * 60 * 5,
  });
}

export function useAutomation(id: string | undefined) {
  return useQuery({
    queryKey: [...AUTOMATIONS_KEY, 'detail', id],
    queryFn: () => api.automations.get(id ?? ''),
    enabled: id !== undefined,
  });
}

export function useCreateAutomation() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateAutomationInput) => api.automations.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      toast.success(t('toast.success.automationCreated.title'), {
        description: t('toast.success.automationCreated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.automationCreateFailed'), { description: error.message });
    },
  });
}

export function useUpdateAutomation() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    /** Silent is for a caller sending a second half after this one; that half says so. */
    mutationFn: ({ id, data }: { id: string; data: UpdateAutomationInput; silent?: boolean }) =>
      api.automations.update(id, data),
    onSuccess: (_saved, { silent }) => {
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      if (silent === true) return;
      toast.success(t('toast.success.automationUpdated.title'), {
        description: t('toast.success.automationUpdated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.automationUpdateFailed'), { description: error.message });
    },
  });
}

/** Optimistic across every cached list page, so the switch never lags the click. */
export function useToggleAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.automations.update(id, { isActive }),
    onMutate: async ({ id, isActive }) => {
      await queryClient.cancelQueries({ queryKey: AUTOMATIONS_KEY });
      const previous = queryClient.getQueriesData<ListResponse<Automation>>({
        queryKey: AUTOMATIONS_KEY,
      });

      queryClient.setQueriesData<ListResponse<Automation>>({ queryKey: AUTOMATIONS_KEY }, (old) => {
        if (!old?.data) return old;
        return {
          ...old,
          data: old.data.map((automation) =>
            automation.id === id ? { ...automation, isActive } : automation
          ),
        };
      });

      return { previous };
    },
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
    },
  });
}

/** New answers to what the template asked; the definition is written from them again. */
export function useRebindAutomation() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, inputs }: { id: string; inputs: Record<string, unknown> }) =>
      api.automations.rebind(id, inputs),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      toast.success(t('toast.success.automationUpdated.title'), {
        description: t('toast.success.automationUpdated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.automationUpdateFailed'), { description: error.message });
    },
  });
}

/**
 * The share code for one automation; the author it carries is part of what is asked for,
 * and the code already on screen stays there while a new name settles.
 */
export function useExportAutomation(id: string | undefined, author: string, group?: TemplateGroup) {
  return useQuery({
    queryKey: [...AUTOMATIONS_KEY, 'export', id, author, group],
    queryFn: () => api.automations.export(id ?? '', author, group),
    enabled: id !== undefined,
    placeholderData: (prev) => prev,
  });
}

/** One way: the row keeps its definition and loses the template that wrote it. */
export function useDetachAutomation() {
  const { t } = useTranslation(['pages', 'notifications']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.automations.detach(id),
    onSuccess: (detached) => {
      // The builder reads this row on the next tick. Seeding it before the refetch is
      // what stops it bouncing the caller back for a template the row no longer has.
      queryClient.setQueryData([...AUTOMATIONS_KEY, 'detail', detached.id], detached);
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
    },
    onError: (error: Error) => {
      toast.error(t('pages:automations.template.customizeFailed'), { description: error.message });
    },
  });
}

/** Rebinds the row onto the template's current version with the inputs it was reviewed with. */
export function useUpgradeAutomation() {
  const { t } = useTranslation(['pages', 'notifications']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, inputs }: { id: string; inputs: Record<string, unknown> }) =>
      api.automations.upgrade(id, inputs),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      toast.success(t('notifications:toast.success.automationUpdated.title'), {
        description: t('notifications:toast.success.automationUpdated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('pages:automations.template.upgradeFailed'), { description: error.message });
    },
  });
}

export function useDeleteAutomation() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.automations.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      toast.success(t('toast.success.automationDeleted.title'), {
        description: t('toast.success.automationDeleted.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.automationDeleteFailed'), { description: error.message });
    },
  });
}

export function useBulkToggleAutomations() {
  const { t } = useTranslation(['notifications', 'pages', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ ids, isActive }: { ids: string[]; isActive: boolean }) =>
      api.automations.bulkUpdate(ids, isActive),
    onSuccess: (data, { isActive }) => {
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      const action = isActive ? t('pages:automations.enable') : t('pages:automations.disable');
      toast.success(action, {
        description: t('common:count.automation', { count: data.updated }),
      });
    },
    onError: (error: Error) => {
      toast.error(t('notifications:toast.error.automationUpdateFailed'), {
        description: error.message,
      });
    },
  });
}

export function useBulkDeleteAutomations() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) => api.automations.bulkDelete(ids),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      toast.success(t('notifications:toast.success.automationDeleted.title'), {
        description: t('common:count.automation', { count: data.deleted }),
      });
    },
    onError: (error: Error) => {
      toast.error(t('notifications:toast.error.automationDeleteFailed'), {
        description: error.message,
      });
    },
  });
}
