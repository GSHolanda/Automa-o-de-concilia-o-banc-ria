import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { errorMessage } from '../../api/client';
import { useToast } from '../../components/Toast';

export interface WriteOptions<TVars, TResult> {
  mutationFn: (vars: TVars) => Promise<TResult>;
  /** Listas a invalidar após o sucesso (prefixos de queryKey). */
  invalidate: QueryKey[];
  /** Mensagem de sucesso (texto ou função do resultado). Omita para não avisar. */
  success?: string | ((result: TResult, vars: TVars) => string);
  /** true: o erro não vira aviso; leia `errorText` e mostre no formulário. */
  inlineError?: boolean;
  onSuccess?: (result: TResult, vars: TVars) => void;
}

/** Mutação de escrita padrão: invalida listas, avisa sucesso e traduz o erro da API. */
export function useWrite<TVars = void, TResult = unknown>(options: WriteOptions<TVars, TResult>) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (result, vars) => {
      await Promise.all(options.invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (options.success) toast.success(typeof options.success === 'function' ? options.success(result, vars) : options.success);
      options.onSuccess?.(result, vars);
    },
    onError: (error) => {
      if (!options.inlineError) toast.error(errorMessage(error));
    },
  });
  return { ...mutation, errorText: mutation.error ? errorMessage(mutation.error) : null };
}
